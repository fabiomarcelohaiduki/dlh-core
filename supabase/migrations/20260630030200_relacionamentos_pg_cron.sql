-- =====================================================================
-- Feature: Relacionamentos (Documento feature-relacionamentos.md / SPEC secao 2.3.3 e 2.4.2)
-- Migration parte 3/3: pg_cron diario 00:00 que dispara o backfill.
--
-- disparar_relacionamentos_backfill() — SECURITY DEFINER:
--   Faz net.http_post para a Edge /functions/v1/relacionamentos-backfill
--   com header X-Cron-Secret lido de vault.decrypted_secrets
--   (CRON_DISPATCH_SECRET). A base da URL vem de EDGE_BASE_URL quando
--   existir no Vault; caso contrario, usa o projeto Supabase atual.
--   NAO executa logica de backfill - apenas HTTP POSTa para a Edge que
--   contem a logica real.
--   SET search_path = public, pg_temp, net (idem triagem-cron).
--   SET net.http_timeout = '20s' para a chamada HTTP (evita ambiguidade
--   entre ms e segundos do parametro 'timeout' do pg_net entre versoes).
--   REVOKE/GRANT: service_role only (cron executa via service_role).
--
-- Job pg_cron:
--   Nome        : 'relacionamentos-backfill'
--   Schedule    : '0 0 * * *' (00:00 diario, horario local)
--   Comando     : select public.disparar_relacionamentos_backfill();
--   Timeout HTTP: 20s (net.http_timeout).
--
-- Instalacao idempotente: cron.unschedule dentro de
-- do $$ ... exception when others then null; $$ antes de cron.schedule.
--
-- create or replace function garante que re-aplicacao substitui versoes
-- anteriores sem erro de "function already exists".
-- =====================================================================

-- ---------------------------------------------------------------------
-- Funcao disparar_relacionamentos_backfill()
-- SECURITY DEFINER + plpgsql. Padrao identico a disparar_triagem_descarte,
-- diferindo apenas na URL da Edge alvo e no GUC net.http_timeout explicito.
-- ---------------------------------------------------------------------
create or replace function public.disparar_relacionamentos_backfill()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp, net
set net.http_timeout = '20s'
as $$
declare
  v_base_url text;
  v_url      text;
  v_secret   text;
  v_req_id   bigint;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
  if v_secret is null then
    raise warning 'disparar_relacionamentos_backfill: segredo CRON_DISPATCH_SECRET ausente no Vault';
    return null;
  end if;

  select decrypted_secret into v_base_url
    from vault.decrypted_secrets where name = 'EDGE_BASE_URL' limit 1;

  v_url := rtrim(
    coalesce(v_base_url, 'https://qvggrrirsjidtqsdvmxf.supabase.co'),
    '/'
  ) || '/functions/v1/relacionamentos-backfill';

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

comment on function public.disparar_relacionamentos_backfill() is
  'Relacionamentos: dispara a Edge /functions/v1/relacionamentos-backfill via pg_net com base EDGE_BASE_URL do Vault (fallback projeto Supabase atual) e header X-Cron-Secret lido de vault.decrypted_secrets (CRON_DISPATCH_SECRET). NAO executa logica de backfill - apenas HTTP POSTa para a Edge, que contem a logica real. Chamada pelo cron diario ''relacionamentos-backfill'' (00:00 local).';

revoke all on function public.disparar_relacionamentos_backfill() from public;
revoke execute on function public.disparar_relacionamentos_backfill() from anon;
revoke execute on function public.disparar_relacionamentos_backfill() from authenticated;
grant execute on function public.disparar_relacionamentos_backfill() to service_role;

-- ---------------------------------------------------------------------
-- Agendamento idempotente do job pg_cron.
-- Idem triagem-descarte: unschedule dentro de do $$ ... exception
-- when others then null; $$ antes do schedule — re-aplicacao da
-- migration e segura (nao duplica jobs).
-- ---------------------------------------------------------------------
do $$
begin
  perform cron.unschedule('relacionamentos-backfill');
exception when others then
  null; -- job ainda nao existe; segue.
end;
$$;

select cron.schedule(
  'relacionamentos-backfill',
  '0 0 * * *',
  $job$ select public.disparar_relacionamentos_backfill(); $job$
);
