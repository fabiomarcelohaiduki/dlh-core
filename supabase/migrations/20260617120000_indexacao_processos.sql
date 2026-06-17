-- =====================================================================
-- Migration: INDEXACAO (embeddings) dos PROCESSOS do Nomus -> RAG.
--
-- CONTEXTO: a memoria semantica (memoria_chunks) hoje so cobre o ACERVO de
-- DOCUMENTOS (origem='documento', 486k chunks). Os PROCESSOS do Nomus
-- (nomus_processos.descricao — dossie operacional da conta, descricao da
-- venda governamental etc., 4485 com descricao, ~55,8M chars) NAO sao
-- buscaveis semanticamente: so via SQL/campos. Esta migration adiciona a
-- PERNA de processos ao MESMO indice memoria_chunks com origem='processo'
-- (vetores OpenAI text-embedding-3-small, dim 1024, MESMO HNSW global).
--
-- ARQUITETURA (espelha o backfill de documentos, decisao 2026-06-17):
--   - REUSA o singleton config_indexacao (orcamento lote_chunks, pausa_ms,
--     tentativas_max, tpm_alvo) + o LOCK GLOBAL (try_lock_indexacao /
--     unlock_indexacao). O lock compartilhado SERIALIZA documentos e
--     processos -> nunca rodam em paralelo -> o teto de TPM da OpenAI nunca
--     e dobrado (evita o storm de 429). Adiciona SO um novo master switch
--     `processos_ativo` (cockpit; inicia OFF).
--   - Fila PROPRIA em nomus_processos: chunks_indexados (checkpoint
--     intra-documento), tentativas_indexacao (auto-retry), descricao_chars
--     (materializada -> selecao da fila sem detoast dos 55 MB).
--   - RPCs proprias (Nomus e fonte unica -> SEM filtro de fonte):
--     claim_processos_indexacao, tem_processo_pendente_indexacao,
--     resumo_indexacao_processos, marcar_falha_indexacao_processo,
--     reenfileirar_erros_indexacao_processos, reenfileirar_indexacao_processos.
--   - busca_semantica_processos: HNSW cosine sobre origem='processo',
--     enriquecida com nome/tipo/etapa/pessoa de nomus_processos.
--   - cron `processos-kick`: marca-passo que religa a cadeia se ela parar
--     (no-op com switch OFF ou fila vazia).
--
-- O verbatim indexado e a descricao com HTML removido (a descricao e HTML;
-- o strip roda no Edge processos-indexar, ponto unico). O chunking
-- (chunkText) e o motor (generateAndStoreMemoriaChunksSlice) sao os MESMOS
-- dos documentos -> recall total, crash-safe por fatia, surrogate-safe.
--
-- BACKFILL de descricao_chars roda FORA desta migration (script isolado com
-- session_replication_role=replica), pelo mesmo motivo do texto_chars dos
-- documentos: um UPDATE em massa dispararia trg_set_updated_at_nomus_processos
-- e reescreveria updated_at de toda a base (usado p/ detectar orfaos
-- em_andamento>15min). A coluna nasce NULL; ate o backfill, processos com
-- descricao_chars NULL ficam fora da fila (descricao_chars>0 = false) —
-- estado seguro.
--
-- Idempotente: add column if not exists / create or replace / if not exists /
-- cron.schedule substitui job homonimo. Aplicar via Node `pg`
-- (SUPABASE_DB_URL), padrao do projeto (NUNCA supabase db push).
-- =====================================================================

-- ---------------------------------------------------------------------
-- (1) Colunas de fila em nomus_processos.
-- ---------------------------------------------------------------------
alter table public.nomus_processos
  add column if not exists chunks_indexados int not null default 0;

comment on column public.nomus_processos.chunks_indexados is
  'Checkpoint da indexacao: numero de chunks (do inicio da descricao) ja embeddados e persistidos em memoria_chunks (origem=processo). Permite retomar processos grandes sem reprocessar do zero. 0 = nao iniciado; = total de chunks quando concluido.';

alter table public.nomus_processos
  add column if not exists tentativas_indexacao int not null default 0;

comment on column public.nomus_processos.tentativas_indexacao is
  'Contador de falhas de indexacao do processo: auto-retry (volta pendente) enquanto < config_indexacao.tentativas_max; erro definitivo ao atingir o teto.';

-- Tamanho materializado da descricao (evita detoast dos ~55 MB na selecao
-- da fila). Nasce NULL; backfill roda em script isolado (ver cabecalho).
alter table public.nomus_processos
  add column if not exists descricao_chars int;

comment on column public.nomus_processos.descricao_chars is
  'length(descricao) materializado, mantido por trigger. A selecao da fila de indexacao le SO esta coluna (nunca o conteudo) -> sem detoast em massa. NULL ate o backfill inicial -> fora da fila (estado seguro).';

-- ---------------------------------------------------------------------
-- (2) Trigger que mantem descricao_chars em dia (insert + update de descricao).
-- ---------------------------------------------------------------------
create or replace function public.fn_set_descricao_chars()
returns trigger
language plpgsql
as $$
begin
  new.descricao_chars := coalesce(length(new.descricao), 0);
  return new;
end;
$$;

drop trigger if exists trg_set_descricao_chars on public.nomus_processos;
create trigger trg_set_descricao_chars
  before insert or update of descricao on public.nomus_processos
  for each row execute function public.fn_set_descricao_chars();

-- ---------------------------------------------------------------------
-- (3) Indice parcial da fila: acha candidatos ordenados sem varrer tudo.
-- ---------------------------------------------------------------------
create index if not exists idx_nomus_processos_fila_indexacao
  on public.nomus_processos (status_indexacao, created_at)
  where descricao_chars > 0;

-- ---------------------------------------------------------------------
-- (4) Master switch da perna de processos (singleton config_indexacao).
--     Inicia OFF: ligar pelo cockpit so apos medir 1 processo.
-- ---------------------------------------------------------------------
alter table public.config_indexacao
  add column if not exists processos_ativo boolean not null default false;

comment on column public.config_indexacao.processos_ativo is
  'Master switch da indexacao de PROCESSOS (nomus_processos -> memoria_chunks origem=processo). Independente de config_indexacao.ativo (que governa DOCUMENTOS). Compartilha orcamento/lock/pacing com a perna de documentos. Inicia OFF.';

-- ---------------------------------------------------------------------
-- (5) claim_processos_indexacao — reivindica lote por orcamento de chars.
--     Nomus e fonte UNICA -> sem filtro de fonte. Marca em_andamento no
--     mesmo comando (FOR UPDATE SKIP LOCKED). Retorna metadados curtos +
--     descricao (HTML) + checkpoint. descricao so e detoastada no RETURNING
--     dos poucos selecionados; a selecao usa descricao_chars.
-- ---------------------------------------------------------------------
create or replace function public.claim_processos_indexacao(
  p_max_chars bigint
)
returns table (
  id               uuid,
  nome             text,
  tipo             text,
  etapa            text,
  pessoa           text,
  descricao        text,
  chunks_indexados int
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with bloqueados as (
    select p.id,
           p.created_at,
           coalesce(p.tentativas_indexacao, 0) as tent,
           coalesce(p.descricao_chars, 0) as chars
    from public.nomus_processos p
    where (
            p.status_indexacao = 'pendente'
            or (p.status_indexacao = 'em_andamento'
                and p.updated_at < now() - interval '15 minutes')
          )
      and p.descricao_chars > 0
    order by coalesce(p.tentativas_indexacao, 0) asc, p.created_at asc, p.id asc
    for update skip locked
    limit 2000
  ),
  acumulado as (
    select b.id,
           b.chars,
           sum(b.chars) over (
             order by b.tent asc, b.created_at asc, b.id asc
             rows between unbounded preceding and current row
           ) as soma
    from bloqueados b
  ),
  selecionados as (
    select a.id
    from acumulado a
    where a.soma - a.chars < p_max_chars
  ),
  claimed as (
    update public.nomus_processos p
    set status_indexacao = 'em_andamento'
    where p.id in (select s.id from selecionados s)
    returning p.id, p.nome, p.tipo, p.etapa, p.pessoa, p.descricao,
              coalesce(p.chunks_indexados, 0) as chunks_indexados
  )
  select c.id, c.nome, c.tipo, c.etapa, c.pessoa, c.descricao, c.chunks_indexados
  from claimed c;
end;
$$;

comment on function public.claim_processos_indexacao(bigint) is
  'Reivindica atomicamente um lote de processos a indexar (pendente OU em_andamento orfao>15min) com FOR UPDATE SKIP LOCKED, limitado por orcamento de caracteres (via descricao_chars, sem detoast na selecao). Ordena por tentativas_indexacao asc, created_at asc (fairness). Marca em_andamento no mesmo comando. Retorna chunks_indexados (checkpoint). Sempre >=1 processo.';

revoke all on function public.claim_processos_indexacao(bigint) from public, anon, authenticated;
grant execute on function public.claim_processos_indexacao(bigint) to service_role;

-- ---------------------------------------------------------------------
-- (6) tem_processo_pendente_indexacao — ainda ha trabalho?
-- ---------------------------------------------------------------------
create or replace function public.tem_processo_pendente_indexacao()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.nomus_processos p
    where (
            p.status_indexacao = 'pendente'
            or (p.status_indexacao = 'em_andamento'
                and p.updated_at < now() - interval '15 minutes')
          )
      and p.descricao_chars > 0
  );
$$;

comment on function public.tem_processo_pendente_indexacao() is
  'True se ainda ha processo a indexar (mesma regra do claim, via descricao_chars). Decide o reenfileiramento do Edge processos-indexar.';

revoke all on function public.tem_processo_pendente_indexacao() from public, anon, authenticated;
grant execute on function public.tem_processo_pendente_indexacao() to service_role;

-- ---------------------------------------------------------------------
-- (7) resumo_indexacao_processos — contagem por status (cockpit).
-- ---------------------------------------------------------------------
create or replace function public.resumo_indexacao_processos()
returns table (status text, total bigint)
language sql
security definer
set search_path = public
as $$
  select p.status_indexacao::text as status, count(*)::bigint as total
  from public.nomus_processos p
  where p.descricao_chars > 0
  group by p.status_indexacao;
$$;

comment on function public.resumo_indexacao_processos() is
  'Contagem de processos indexaveis (descricao_chars>0) por status_indexacao. Alimenta o painel de Indexacao do cockpit (perna de processos).';

revoke all on function public.resumo_indexacao_processos() from public, anon, authenticated;
grant execute on function public.resumo_indexacao_processos() to service_role;

-- ---------------------------------------------------------------------
-- (8) marcar_falha_indexacao_processo — auto-retry com teto.
-- ---------------------------------------------------------------------
create or replace function public.marcar_falha_indexacao_processo(
  p_id   uuid,
  p_teto int
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  update public.nomus_processos p
  set tentativas_indexacao = coalesce(p.tentativas_indexacao, 0) + 1,
      status_indexacao = case
        when coalesce(p.tentativas_indexacao, 0) + 1 >= greatest(p_teto, 1)
          then 'erro'
        else 'pendente'
      end
  where p.id = p_id
  returning p.status_indexacao into v_status;
  return v_status;
end;
$$;

comment on function public.marcar_falha_indexacao_processo(uuid, int) is
  'Registra uma falha de indexacao do processo: incrementa tentativas_indexacao e re-marca pendente enquanto abaixo do teto (auto-retry pela cadeia), ou erro definitivo ao atingir o teto. Retorna o status resultante. Preserva chunks_indexados (retoma do checkpoint).';

revoke all on function public.marcar_falha_indexacao_processo(uuid, int) from public, anon, authenticated;
grant execute on function public.marcar_falha_indexacao_processo(uuid, int) to service_role;

-- ---------------------------------------------------------------------
-- (9) reenfileirar_erros_indexacao_processos — retry manual (zera estado).
-- ---------------------------------------------------------------------
create or replace function public.reenfileirar_erros_indexacao_processos()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_reenfileirados integer;
begin
  with alvo as (
    update public.nomus_processos p
    set status_indexacao = 'pendente',
        tentativas_indexacao = 0,
        chunks_indexados = 0
    where p.status_indexacao = 'erro'
      and p.descricao_chars > 0
    returning p.id
  )
  select count(*)::int into v_reenfileirados from alvo;

  if v_reenfileirados > 0 then
    perform public.reenfileirar_indexacao_processos();
  end if;

  return v_reenfileirados;
end;
$$;

comment on function public.reenfileirar_erros_indexacao_processos() is
  'Move os processos em status_indexacao=erro de volta para pendente, ZERANDO tentativas_indexacao e chunks_indexados (retry limpo do zero). Dispara reenfileirar_indexacao_processos() para reabrir o backfill. Retorna a quantidade reenfileirada.';

revoke all on function public.reenfileirar_erros_indexacao_processos() from public, anon, authenticated;
grant execute on function public.reenfileirar_erros_indexacao_processos() to service_role;

-- ---------------------------------------------------------------------
-- (10) reenfileirar_indexacao_processos — encadeia o proximo lote (pg_net).
-- ---------------------------------------------------------------------
create or replace function public.reenfileirar_indexacao_processos()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url     text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/processos-indexar';
  v_secret  text;
  v_req_id  bigint;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
  if v_secret is null then
    raise warning 'reenfileirar_indexacao_processos: segredo CRON_DISPATCH_SECRET ausente no Vault';
    return null;
  end if;

  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'X-Cron-Secret', v_secret
               ),
    body    := '{}'::jsonb
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.reenfileirar_indexacao_processos() is
  'Reenfileira o Edge processos-indexar para o proximo lote de backfill (net.http_post via pg_net). Chamada pelo proprio Edge ao fim de um lote quando ainda ha pendentes, encadeando ate esgotar a fila.';

revoke all on function public.reenfileirar_indexacao_processos() from public, anon, authenticated;
grant execute on function public.reenfileirar_indexacao_processos() to service_role;

-- ---------------------------------------------------------------------
-- (11) busca_semantica_processos — HNSW cosine sobre origem='processo'.
--      Enriquecida com nome/tipo/etapa/pessoa de nomus_processos. O order
--      by embedding <=> p_embedding limit k roda direto sobre o indice HNSW
--      global; o join so enriquece o top-K ja cortado.
-- ---------------------------------------------------------------------
create or replace function public.busca_semantica_processos(
  p_embedding vector(1024),
  p_limite    int default 5
)
returns table (
  processo_id  uuid,
  chunk_index  int,
  verbatim     text,
  similaridade double precision,
  nome         text,
  tipo         text,
  etapa        text,
  pessoa       text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with limites as (
    select greatest(1, least(coalesce(p_limite, 5), 50)) as k
  ),
  match as (
    select
      m.registro_id                       as processo_id,
      m.chunk_index                       as chunk_index,
      m.verbatim                          as verbatim,
      (1 - (m.embedding <=> p_embedding)) as similaridade,
      (m.embedding <=> p_embedding)       as distancia
    from public.memoria_chunks m
    where m.origem = 'processo'
      and m.embedding is not null
    order by m.embedding <=> p_embedding
    limit (select k from limites)
  )
  select
    mt.processo_id,
    mt.chunk_index,
    mt.verbatim,
    mt.similaridade,
    p.nome,
    p.tipo,
    p.etapa,
    p.pessoa
  from match mt
  left join public.nomus_processos p on p.id = mt.processo_id
  order by mt.distancia;
$$;

comment on function public.busca_semantica_processos(vector, int) is
  'Busca semantica HNSW (cosine) sobre os PROCESSOS do Nomus (memoria_chunks origem=processo). Retorna trecho casado + processo de origem (nome/tipo/etapa/pessoa). Autorizacao na borda; somente service_role executa.';

revoke all on function public.busca_semantica_processos(vector, int) from public, anon, authenticated;
grant execute on function public.busca_semantica_processos(vector, int) to service_role;

-- ---------------------------------------------------------------------
-- (12) Cron de seguranca: marca-passo que reabre a cadeia se ela parar.
--      So dispara com processos_ativo ON e fila com pendente; senao no-op.
--      A cada 10 min (a perna de documentos usa o seu proprio kick).
-- ---------------------------------------------------------------------
select cron.schedule(
  'processos-kick',
  '*/10 * * * *',
  $cron$
    select public.reenfileirar_indexacao_processos()
    where coalesce((select processos_ativo from public.config_indexacao limit 1), false)
      and public.tem_processo_pendente_indexacao();
  $cron$
);
