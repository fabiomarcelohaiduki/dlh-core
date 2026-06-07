-- =====================================================================
-- Sprint: Substrato de dados (secao 2.3 da SPEC)
-- Migration 06/08: Job pg_cron de coleta agendada
-- Cria o job que dispara a Edge Function de coleta conforme config_ingestao
-- (US-03, RF-04). Alteracoes de agendamento/janela valem na proxima execucao,
-- sem redeploy.
--
-- IMPORTANTE: a chamada HTTP para a Edge Function fica como placeholder
-- COMENTADO ate a funcao `ingestao-coletar` existir. O JOB e criado agora
-- (corpo no-op) para validar o agendamento; o corpo sera atualizado quando
-- a Edge Function e o segredo de service_role estiverem disponiveis.
-- =====================================================================

-- Idempotencia: remove um job homonimo previo, se houver (ignora ausencia).
do $$
begin
  perform cron.unschedule('coleta-effecti-agendada');
exception when others then
  null; -- job ainda nao existe; segue.
end;
$$;

-- Agenda placeholder: 06:00 (UTC) diariamente. A frequencia/horario reais
-- sao governados por config_ingestao e serao reconfigurados pela aplicacao.
select cron.schedule(
  'coleta-effecti-agendada',
  '0 6 * * *',
  $job$
    -- =================================================================
    -- PLACEHOLDER: dispara a Edge Function de coleta quando ela existir.
    -- Habilitar quando `ingestao-coletar` estiver publicada e o segredo
    -- de service_role configurado (ex.: via Vault / pg_settings).
    -- Requer a extensao pg_net (net.http_post) habilitada.
    --
    -- select net.http_post(
    --   url     := 'https://<SUPABASE_PROJECT_REF>.functions.supabase.co/ingestao-coletar',
    --   headers := jsonb_build_object(
    --                'Content-Type',  'application/json',
    --                'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    --              ),
    --   body    := jsonb_build_object('fonte', 'effecti', 'gatilho', 'agendada')
    -- );
    -- =================================================================
    select 1;  -- no-op ate a Edge Function existir
  $job$
);
