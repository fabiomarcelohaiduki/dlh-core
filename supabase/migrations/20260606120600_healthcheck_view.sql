-- =====================================================================
-- Sprint: Substrato de dados (secao 2.5 da SPEC)
-- Migration 07/08: View vw_healthcheck
-- View derivada (nao tabela) de execucoes + avisos + erros_ingestao.
-- Expoe: status_ingestao, ultima_sync, total_avisos, itens_com_erro.
-- Mapeamento de status (api-healthcheck / US-15):
--   operacional -> "Saudavel" | degradado -> "Atencao" | parado -> "Falha"
--
-- security_invoker = true (PG15+): a view respeita a RLS das tabelas-base
-- no contexto do usuario que consulta (defense in depth).
-- =====================================================================

create or replace view public.vw_healthcheck
with (security_invoker = true)
as
with ultima_execucao as (
  -- execucao mais recente (qualquer status), para detectar falha total.
  select status
  from public.execucoes
  order by inicio desc
  limit 1
),
ultima_sync_ok as (
  -- marcador de ultima sync bem-sucedida = derivado de execucoes concluidas (RNF-06).
  select max(fim) as ultima_sync
  from public.execucoes
  where status = 'concluida'
),
totais as (
  select count(*)::int as total_avisos from public.avisos
),
erros as (
  select count(*)::int as itens_com_erro from public.erros_ingestao
)
select
  -- Derivacao do status operacional da ingestao.
  case
    when (select status from ultima_execucao) = 'erro'      then 'parado'      -- Falha
    when (select itens_com_erro from erros) > 0             then 'degradado'   -- Atencao
    when (select ultima_sync from ultima_sync_ok) is not null then 'operacional' -- Saudavel
    else 'parado'                                                              -- sem sync ainda
  end                                            as status_ingestao,
  (select ultima_sync   from ultima_sync_ok)     as ultima_sync,
  (select total_avisos  from totais)             as total_avisos,
  (select itens_com_erro from erros)             as itens_com_erro;

comment on view public.vw_healthcheck is
  'Healthcheck derivado (US-15): status_ingestao (operacional/degradado/parado), ultima_sync, total_avisos, itens_com_erro.';
