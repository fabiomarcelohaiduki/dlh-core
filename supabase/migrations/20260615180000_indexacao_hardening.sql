-- =====================================================================
-- Migration: HARDENING da indexacao (achados do code-review).
--
--   C1 (CRITICO) — claim_documentos_indexacao agora reivindica com
--       FOR UPDATE SKIP LOCKED. O caminho NORMAL e concorrente: o humano
--       clica "Indexar agora" e o auto-encadeamento (reenfileirar_indexacao
--       -> net.http_post) dispara em paralelo. Sem o lock de linha, duas
--       invocacoes computavam o MESMO conjunto de candidatos e ambas davam
--       UPDATE ... RETURNING -> chunks duplicados + gasto dobrado na OpenAI.
--       O UPDATE sozinho NAO bastava: em READ COMMITTED o WHERE e por id (nao
--       por status), entao a 2a transacao re-atualizava as mesmas linhas.
--       Agora a selecao de candidatos trava as linhas e a invocacao
--       concorrente PULA (SKIP LOCKED) as ja reservadas -> lotes disjuntos.
--       Como window function nao convive com FOR UPDATE no mesmo SELECT, o
--       lock fica numa CTE `bloqueados` (SELECT puro, ordenado, LIMIT de
--       seguranca p/ nao travar dezenas de milhares de linhas de uma vez),
--       e o orcamento de chars (window) e aplicado por cima do conjunto ja
--       travado. Garantia de progresso (>=1 doc) preservada.
--
--   M4 — config_indexacao ganha indice unico de SINGLETON (expressao
--       constante) -> impede 2a linha fantasma; insert concorrente falha
--       alto em vez de silenciosamente duplicar a config global.
--
--   Idempotente: create or replace / if not exists. Aplicar via Node `pg`
--   (SUPABASE_DB_URL), padrao do projeto (NUNCA supabase db push).
-- =====================================================================

-- ---------------------------------------------------------------------
-- C1: claim_documentos_indexacao com FOR UPDATE SKIP LOCKED.
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
    -- ordenadas, pulando o que outra invocacao ja reservou. LIMIT de
    -- seguranca: bound nos locks (o orcamento de chars trima de novo abaixo).
    select d.id,
           d.tipo_documento,
           d.texto,
           d.created_at,
           coalesce(length(d.texto), 0) as chars
    from public.documentos d
    where (
            d.status_indexacao = 'pendente'
            or (d.status_indexacao = 'em_andamento'
                and d.updated_at < now() - interval '15 minutes')
          )
      and d.texto is not null
      and length(d.texto) > 0
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
    select b.*,
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
  'Reivindica atomicamente um lote de documentos a indexar (pendente OU em_andamento orfao>15min) com FOR UPDATE SKIP LOCKED, filtrado por fonte e limitado por orcamento de caracteres (proxy de chunks). Invocacoes concorrentes pegam lotes disjuntos. Marca em_andamento no mesmo comando. Sempre >=1 doc.';

revoke all on function public.claim_documentos_indexacao(text[], bigint) from public, anon, authenticated;
grant execute on function public.claim_documentos_indexacao(text[], bigint) to service_role;

-- ---------------------------------------------------------------------
-- M4: singleton unico em config_indexacao (so 1 linha de config global).
-- ---------------------------------------------------------------------
create unique index if not exists config_indexacao_singleton
  on public.config_indexacao ((true));
