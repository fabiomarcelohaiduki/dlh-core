-- =====================================================================
-- Migration: backfill da INDEXACAO (embeddings) de documentos.
--   Tres pecas server-side que o Edge `documentos-indexar` orquestra:
--
--   (1) claim_documentos_indexacao(p_fontes, p_max_chars)
--       Reivindica ATOMICAMENTE um lote de documentos pendentes (status
--       'pendente' OU 'em_andamento' orfao > 15 min), filtrado por fonte
--       via documento_vinculos, limitado por ORCAMENTO DE CARACTERES
--       (proxy de chunks: ~2000 chars/chunk -> p_max_chars = lote_chunks *
--       2000). Marca os escolhidos como 'em_andamento' no MESMO comando
--       (UPDATE ... RETURNING) -> sem corrida entre invocacoes encadeadas.
--       Sempre inclui ao menos 1 doc (garante progresso mesmo com um edital
--       gigante que sozinho estoura o orcamento).
--
--   (2) tem_documento_pendente_indexacao(p_fontes)
--       Boolean barato: ainda ha trabalho da(s) fonte(s)? Decide se o Edge
--       reenfileira o proximo lote.
--
--   (3) reenfileirar_indexacao()
--       Espelha reenfileirar_coleta: net.http_post (pg_net, fire-and-forget
--       pelo banco) no proprio Edge documentos-indexar, encadeando os lotes
--       ate esgotar a fila. Mesmo segredo do Vault (CRON_DISPATCH_SECRET).
--
--   Por que ORFAO POR IDADE: se o Edge morre no meio do lote, os docs ficam
--   'em_andamento'; sem reclaim eles encalham (a selecao so pega 'pendente').
--   Reabrir em_andamento > 15 min replica a auto-cura de orfa da coleta.
--
--   Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
--   padrao do projeto (NUNCA supabase db push).
-- =====================================================================

-- ---------------------------------------------------------------------
-- (1) claim_documentos_indexacao — reivindica lote por fonte + orcamento.
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
  with candidatos as (
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
  ),
  acumulado as (
    select c.*,
           sum(c.chars) over (
             order by c.created_at asc, c.id asc
             rows between unbounded preceding and current row
           ) as soma
    from candidatos c
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
  'Reivindica atomicamente um lote de documentos a indexar (pendente OU em_andamento orfao>15min), filtrado por fonte e limitado por orcamento de caracteres (proxy de chunks). Marca em_andamento no mesmo comando. Sempre >=1 doc.';

revoke all on function public.claim_documentos_indexacao(text[], bigint) from public, anon, authenticated;
grant execute on function public.claim_documentos_indexacao(text[], bigint) to service_role;

-- ---------------------------------------------------------------------
-- (2) tem_documento_pendente_indexacao — ainda ha trabalho?
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
  );
$$;

comment on function public.tem_documento_pendente_indexacao(text[]) is
  'True se ainda ha documento a indexar para a(s) fonte(s) (mesma regra do claim). Decide o reenfileiramento do Edge documentos-indexar.';

revoke all on function public.tem_documento_pendente_indexacao(text[]) from public, anon, authenticated;
grant execute on function public.tem_documento_pendente_indexacao(text[]) to service_role;

-- ---------------------------------------------------------------------
-- (3) reenfileirar_indexacao — encadeia o proximo lote (pg_net).
-- ---------------------------------------------------------------------
create or replace function public.reenfileirar_indexacao()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url     text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/documentos-indexar';
  v_secret  text;
  v_req_id  bigint;
begin
  -- Segredo de sistema do Vault (mesmo que autentica o job pg_cron / coleta).
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
  if v_secret is null then
    raise warning 'reenfileirar_indexacao: segredo CRON_DISPATCH_SECRET ausente no Vault';
    return null;
  end if;

  -- Dispara o Edge de indexacao para o proximo lote (assincrono). Body vazio:
  -- o Edge le config_indexacao (master switch + fontes + orcamento) por conta.
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

comment on function public.reenfileirar_indexacao() is
  'Reenfileira o Edge documentos-indexar para o proximo lote de backfill (net.http_post via pg_net). Chamada pelo proprio Edge ao fim de um lote quando ainda ha pendentes, encadeando ate esgotar a fila.';

revoke all on function public.reenfileirar_indexacao() from public, anon, authenticated;
grant execute on function public.reenfileirar_indexacao() to service_role;
