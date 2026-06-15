-- =====================================================================
-- Migration: CHECKPOINT INTRA-DOCUMENTO da indexacao (recall total).
--
-- PROBLEMA (diagnostico 2026-06-15): a indexacao processava o DOCUMENTO
-- INTEIRO por invocacao do Edge. Documentos enormes (ate ~4,4M chars =
-- ~2200 chunks = ~70 requests OpenAI em burst) estouravam o wall-clock do
-- Edge, deixando a linha orfa em 'em_andamento'. O orcamento por lote
-- (lote_chunks/pausa_ms) NAO resolvia: um unico doc grande estoura sozinho.
-- Truncar o texto do doc foi REJEITADO pelo Fabio ("nao posso perder
-- informacoes" -> recall total, indexar 100% de cada documento).
--
-- SOLUCAO: checkpoint POR CHUNK dentro do documento. Coluna
-- documentos.chunks_indexados guarda quantos chunks (do inicio) ja foram
-- embeddados e persistidos. O Edge processa uma FATIA de chunks por
-- invocacao [chunks_indexados, chunks_indexados + orcamento), salva o
-- checkpoint, devolve o doc a 'pendente' e retoma na proxima invocacao.
-- Doc concluido -> 'concluida'. Idempotente por fatia: o motor deleta a
-- cauda (chunk_index >= offset) antes de inserir, entao um crash no meio
-- da fatia nao deixa chunk duplicado nem buraco (re-processa a fatia toda).
--
-- Esta migration so toca o SCHEMA + as RPCs de fila:
--   1. coluna documentos.chunks_indexados (default 0)
--   2. claim_documentos_indexacao passa a RETORNAR chunks_indexados
--      (o Edge precisa do offset de retomada). Como o tipo de retorno muda,
--      DROP antes do recreate.
--   3. reenfileirar_erros_indexacao zera chunks_indexados (retry limpo:
--      reprocessa o doc do zero, consistente com o delete da cauda).
--
-- Idempotente. Aplicar via Node `pg` (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Checkpoint por documento: quantos chunks (do inicio) ja indexados.
-- ---------------------------------------------------------------------
alter table public.documentos
  add column if not exists chunks_indexados int not null default 0;

comment on column public.documentos.chunks_indexados is
  'Checkpoint da indexacao: numero de chunks (a partir do inicio do texto) ja embeddados e persistidos em memoria_chunks. Permite retomar documentos grandes sem reprocessar do zero. 0 = nao iniciado; = total de chunks quando concluido.';

-- ---------------------------------------------------------------------
-- 2. claim_documentos_indexacao — retorna tambem o checkpoint.
--    O tipo de retorno mudou (nova coluna) -> precisa DROP antes.
-- ---------------------------------------------------------------------
drop function if exists public.claim_documentos_indexacao(text[], bigint);

create or replace function public.claim_documentos_indexacao(
  p_fontes     text[],
  p_max_chars  bigint
)
returns table (id uuid, tipo_documento text, texto text, chunks_indexados int)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with bloqueados as (
    -- Trava as linhas candidatas (pendente OU em_andamento orfao > 15 min),
    -- ordenadas por (tentativas, created_at): docs que ja falharam vao para
    -- o FIM, evitando travar a fila sob burst. Pula o que outra invocacao ja
    -- reservou. NAO projeta `texto` (evita detoast em massa); usa texto_chars.
    select d.id,
           d.created_at,
           coalesce(d.tentativas_indexacao, 0) as tent,
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
    order by coalesce(d.tentativas_indexacao, 0) asc, d.created_at asc, d.id asc
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
    returning d.id, d.tipo_documento, d.texto, coalesce(d.chunks_indexados, 0) as chunks_indexados
  )
  select c.id, c.tipo_documento, c.texto, c.chunks_indexados from claimed c;
end;
$$;

comment on function public.claim_documentos_indexacao(text[], bigint) is
  'Reivindica atomicamente um lote de documentos a indexar (pendente OU em_andamento orfao>15min) com FOR UPDATE SKIP LOCKED, filtrado por fonte e limitado por orcamento de caracteres (via texto_chars). Ordena por tentativas_indexacao asc, created_at asc -> docs que ja falharam vao para o fim da fila (fairness). Marca em_andamento no mesmo comando. Retorna chunks_indexados (checkpoint de retomada). Sempre >=1 doc.';

revoke all on function public.claim_documentos_indexacao(text[], bigint) from public, anon, authenticated;
grant execute on function public.claim_documentos_indexacao(text[], bigint) to service_role;

-- ---------------------------------------------------------------------
-- 3. reenfileirar_erros_indexacao — zera o checkpoint (retry limpo).
-- ---------------------------------------------------------------------
create or replace function public.reenfileirar_erros_indexacao(
  p_fontes text[]
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_reenfileirados integer;
begin
  with alvo as (
    update public.documentos d
    set status_indexacao = 'pendente',
        tentativas_indexacao = 0,
        chunks_indexados = 0
    where d.status_indexacao = 'erro'
      and d.texto_chars > 0
      and (
        p_fontes is null
        or exists (
          select 1 from public.documento_vinculos v
          where v.documento_id = d.id
            and v.fonte = any(p_fontes)
        )
      )
    returning d.id
  )
  select count(*)::int into v_reenfileirados from alvo;

  -- Reabre o auto-encadeamento do backfill (no-op se o master switch estiver
  -- OFF; o documentos-indexar checa config_indexacao.ativo).
  if v_reenfileirados > 0 then
    perform public.reenfileirar_indexacao();
  end if;

  return v_reenfileirados;
end;
$$;

comment on function public.reenfileirar_erros_indexacao(text[]) is
  'Move os documentos em status_indexacao=erro de volta para pendente (filtrado por fonte, texto_chars>0), ZERANDO tentativas_indexacao e chunks_indexados (retry limpo: reprocessa o doc do zero). Dispara reenfileirar_indexacao() para reabrir o backfill. Retorna a quantidade reenfileirada.';

revoke all on function public.reenfileirar_erros_indexacao(text[]) from public, anon, authenticated;
grant execute on function public.reenfileirar_erros_indexacao(text[]) to service_role;
