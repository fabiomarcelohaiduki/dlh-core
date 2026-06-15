-- =====================================================================
-- Migration: PERFORMANCE da fila de indexacao — coluna texto_chars.
--
--   PROBLEMA (medido ao vivo 2026-06-15): claim/resumo/tem_pendente
--   filtravam a fila por `texto is not null and length(texto) > 0` e o
--   claim ainda computava `length(texto)` no orcamento e projetava `texto`
--   na CTE de candidatos. Com ~35k docs (~730 MB de texto em TOAST), CADA
--   invocacao DESCOMPRIME o texto de milhares de docs so para montar o
--   lote: ate um COUNT levava ~15s e o claim ~20s -> estourava o
--   statement_timeout do service_role no PostgREST (claim_failed) e o
--   auto-encadeamento do backfill NUNCA progredia. Piora com a fila.
--
--   FIX: materializar o tamanho do texto em `documentos.texto_chars` (int),
--   mantido por trigger, e indexado. A SELECAO da fila passa a ler so essa
--   coluna (nunca o conteudo); o `texto` so e detoastado no RETURNING do
--   claim, e apenas dos POUCOS docs que cabem no lote.
--
--     (1) coluna texto_chars (SO DDL, sem backfill aqui — ver nota abaixo)
--     (2) trigger fn_set_texto_chars: mantem texto_chars = length(texto)
--     (3) indice parcial da fila: (status_indexacao, created_at) where >0
--     (4) recria claim/resumo/tem_pendente usando texto_chars (sem detoast
--         na fase de candidatos). Preserva FOR UPDATE SKIP LOCKED (C1),
--         orcamento de chars, garantia de >=1 doc e os grants.
--
--   Idempotente: add column if not exists / create or replace / if not
--   exists. Aplicar via Node `pg` (SUPABASE_DB_URL), padrao do projeto
--   (NUNCA supabase db push).
--
--   BACKFILL FORA DA MIGRATION (decisao 2026-06-15): `documentos` tem dois
--   triggers — trg_audit_documentos (AFTER ... insere 1 linha em audit_log
--   por UPDATE) e trg_set_updated_at_documentos (BEFORE UPDATE reescreve
--   updated_at). Um `update ... set texto_chars` em massa criaria ~35k
--   linhas de auditoria e CORROMPERIA o updated_at de toda a base (que o
--   proprio claim usa p/ detectar orfaos em_andamento>15min). Por isso o
--   preenchimento inicial roda como passo ISOLADO, em UMA sessao com
--   `set session_replication_role = replica` (desliga os dois triggers
--   so naquela sessao, SEM lock de tabela e SEM ALTER), restaurando
--   `origin` ao final. Script: C:\Users\Dell\.dlh-dryrun\backfill-texto-chars.js
--   (revisar e aprovar antes de rodar). A coluna nasce NULL; ate o backfill,
--   docs com texto_chars NULL ficam fora da fila (texto_chars>0 = false) —
--   estado seguro, nada e indexado errado nesse intervalo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (1) Coluna materializada (SO DDL — backfill roda separado, ver cabecalho).
-- ---------------------------------------------------------------------
alter table public.documentos
  add column if not exists texto_chars int;

-- ---------------------------------------------------------------------
-- (2) Trigger que mantem texto_chars em dia (sem tocar no codigo TS de
--     extracao). Recalcula no insert e quando `texto` muda no update.
-- ---------------------------------------------------------------------
create or replace function public.fn_set_texto_chars()
returns trigger
language plpgsql
as $$
begin
  new.texto_chars := coalesce(length(new.texto), 0);
  return new;
end;
$$;

drop trigger if exists trg_set_texto_chars on public.documentos;
create trigger trg_set_texto_chars
  before insert or update of texto on public.documentos
  for each row execute function public.fn_set_texto_chars();

-- ---------------------------------------------------------------------
-- (3) Indice parcial da fila: acha os candidatos ordenados sem varrer a
--     base inteira nem tocar o conteudo (cobre o caso comum 'pendente').
-- ---------------------------------------------------------------------
create index if not exists idx_documentos_fila_indexacao
  on public.documentos (status_indexacao, created_at)
  where texto_chars > 0;

-- ---------------------------------------------------------------------
-- (4a) claim_documentos_indexacao — texto_chars na selecao; texto so no
--      RETURNING dos selecionados. Mantem FOR UPDATE SKIP LOCKED (C1).
-- ---------------------------------------------------------------------
create or replace function public.claim_documentos_indexacao(
  p_fontes     text[],
  p_max_chars  bigint
)
returns table (id uuid, tipo_documento text, texto text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with bloqueados as (
    -- Trava as linhas candidatas (pendente OU em_andamento orfao > 15 min),
    -- ordenadas, pulando o que outra invocacao ja reservou. NAO projeta
    -- `texto` (evita detoast em massa); usa texto_chars materializado.
    select d.id,
           d.created_at,
           coalesce(d.texto_chars, 0) as chars
    from public.documentos d
    where (
            d.status_indexacao = 'pendente'
            or (d.status_indexacao = 'em_andamento'
                and d.updated_at < now() - interval '15 minutes')
          )
      and d.texto_chars > 0
      and (
        p_fontes is null
        or exists (
          select 1 from public.documento_vinculos v
          where v.documento_id = d.id
            and v.fonte = any(p_fontes)
        )
      )
    order by d.created_at asc, d.id asc
    for update skip locked
    limit 2000
  ),
  acumulado as (
    select b.id,
           b.chars,
           sum(b.chars) over (
             order by b.created_at asc, b.id asc
             rows between unbounded preceding and current row
           ) as soma
    from bloqueados b
  ),
  selecionados as (
    -- inclui todos os docs cujo acumulado ANTES dele ainda nao atingiu o
    -- orcamento (soma - chars < p_max_chars). O 1o sempre entra (0 < budget).
    select a.id
    from acumulado a
    where a.soma - a.chars < p_max_chars
  ),
  claimed as (
    update public.documentos d
    set status_indexacao = 'em_andamento'
    where d.id in (select s.id from selecionados s)
    returning d.id, d.tipo_documento, d.texto
  )
  select c.id, c.tipo_documento, c.texto from claimed c;
end;
$$;

comment on function public.claim_documentos_indexacao(text[], bigint) is
  'Reivindica atomicamente um lote de documentos a indexar (pendente OU em_andamento orfao>15min) com FOR UPDATE SKIP LOCKED, filtrado por fonte e limitado por orcamento de caracteres (via texto_chars materializado, sem detoast na selecao). Invocacoes concorrentes pegam lotes disjuntos. Marca em_andamento no mesmo comando. Sempre >=1 doc.';

revoke all on function public.claim_documentos_indexacao(text[], bigint) from public, anon, authenticated;
grant execute on function public.claim_documentos_indexacao(text[], bigint) to service_role;

-- ---------------------------------------------------------------------
-- (4b) resumo_indexacao — contagem por status usando texto_chars.
-- ---------------------------------------------------------------------
create or replace function public.resumo_indexacao(
  p_fontes text[]
)
returns table (status text, total bigint)
language sql
security definer
set search_path = public
as $$
  select d.status_indexacao::text as status, count(*)::bigint as total
  from public.documentos d
  where d.texto_chars > 0
    and (
      p_fontes is null
      or exists (
        select 1 from public.documento_vinculos v
        where v.documento_id = d.id
          and v.fonte = any(p_fontes)
      )
    )
  group by d.status_indexacao;
$$;

comment on function public.resumo_indexacao(text[]) is
  'Contagem de documentos indexaveis (texto_chars>0) por status_indexacao, filtrada por fonte (documento_vinculos). p_fontes null = todas. Alimenta o painel de Indexacao do cockpit.';

revoke all on function public.resumo_indexacao(text[]) from public, anon, authenticated;
grant execute on function public.resumo_indexacao(text[]) to service_role;

-- ---------------------------------------------------------------------
-- (4c) tem_documento_pendente_indexacao — boolean barato usando texto_chars.
-- ---------------------------------------------------------------------
create or replace function public.tem_documento_pendente_indexacao(
  p_fontes text[]
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.documentos d
    where (
            d.status_indexacao = 'pendente'
            or (d.status_indexacao = 'em_andamento'
                and d.updated_at < now() - interval '15 minutes')
          )
      and d.texto_chars > 0
      and (
        p_fontes is null
        or exists (
          select 1 from public.documento_vinculos v
          where v.documento_id = d.id
            and v.fonte = any(p_fontes)
        )
      )
  );
$$;

comment on function public.tem_documento_pendente_indexacao(text[]) is
  'True se ainda ha documento a indexar para a(s) fonte(s) (mesma regra do claim, via texto_chars). Decide o reenfileiramento do Edge documentos-indexar.';

revoke all on function public.tem_documento_pendente_indexacao(text[]) from public, anon, authenticated;
grant execute on function public.tem_documento_pendente_indexacao(text[]) to service_role;
