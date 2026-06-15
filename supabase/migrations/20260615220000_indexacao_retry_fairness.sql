-- =====================================================================
-- Migration: FAIRNESS do auto-retry da indexacao (correcoes do code-review
--   do auto-retry continuo, 2026-06-15).
--
--   (HIGH) claim_documentos_indexacao priorizava por created_at asc. Um doc
--   que falha volta a 'pendente' com created_at ANTIGO -> era re-reivindicado
--   na FRENTE da fila. Sob burst 429 prolongado da OpenAI, os mesmos docs
--   antigos falhavam/voltavam/eram pegos de novo, queimando tentativas_max e
--   indo a 'erro' definitivo, ENQUANTO docs novos nunca eram tentados (fila
--   travada, degradacao de recall — o oposto do que o auto-retry queria).
--   FIX: ordenar por tentativas_indexacao asc ANTES de created_at -> o doc
--   que falhou vai para o FIM da fila; da tempo do burst passar e os docs
--   ineditos avancam. Mantem texto_chars, FOR UPDATE SKIP LOCKED, orcamento
--   e >=1 doc. So muda a ORDEM (selecao e janela acumulada coerentes).
--
--   (LOW) reenfileirar_erros_indexacao (botao manual) movia 'erro'->'pendente'
--   mas NAO zerava tentativas_indexacao -> doc que ja estourou o teto falhava
--   na 1a nova tentativa e voltava direto a 'erro' (reprocesso manual virava
--   uso unico). FIX: zerar tentativas_indexacao no reenfileiramento manual ->
--   retry limpo, como o operador espera.
--
--   Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
--   padrao do projeto (NUNCA supabase db push).
-- =====================================================================

-- ---------------------------------------------------------------------
-- (HIGH) claim_documentos_indexacao — fairness por tentativas.
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
    returning d.id, d.tipo_documento, d.texto
  )
  select c.id, c.tipo_documento, c.texto from claimed c;
end;
$$;

comment on function public.claim_documentos_indexacao(text[], bigint) is
  'Reivindica atomicamente um lote de documentos a indexar (pendente OU em_andamento orfao>15min) com FOR UPDATE SKIP LOCKED, filtrado por fonte e limitado por orcamento de caracteres (via texto_chars). Ordena por tentativas_indexacao asc, created_at asc -> docs que ja falharam vao para o fim da fila (fairness, evita travar sob burst). Marca em_andamento no mesmo comando. Sempre >=1 doc.';

revoke all on function public.claim_documentos_indexacao(text[], bigint) from public, anon, authenticated;
grant execute on function public.claim_documentos_indexacao(text[], bigint) to service_role;

-- ---------------------------------------------------------------------
-- (LOW) reenfileirar_erros_indexacao — zera tentativas (retry limpo).
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
        tentativas_indexacao = 0
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
  'Move os documentos em status_indexacao=erro de volta para pendente (filtrado por fonte, texto_chars>0), ZERANDO tentativas_indexacao (retry limpo), e dispara reenfileirar_indexacao() para reabrir o backfill. Retorna a quantidade reenfileirada. Retry idempotente (chunks inseridos atomicamente no fim do doc).';

revoke all on function public.reenfileirar_erros_indexacao(text[]) from public, anon, authenticated;
grant execute on function public.reenfileirar_erros_indexacao(text[]) to service_role;
