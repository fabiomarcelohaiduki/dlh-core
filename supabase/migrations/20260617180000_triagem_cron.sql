-- =====================================================================
-- Sprint Triagem — Migration 6/6: jobs pg_cron da triagem.
--
--   triagem-descarte         -> diario as 03:00 (UTC): invoca a Edge Function
--                               triagem-descarte-cron, que aplica o descarte
--                               FISICO dos avisos cuja carencia expirou
--                               (governado por config_automacao.descarte_fisico_ligado).
--   triagem-favoritar-retry  -> horario (minuto 0): invoca a Edge Function
--                               triagem-favoritar-retry, que re-tenta propagar
--                               os favoritos pendentes (write-back a Effecti).
--
-- Ambos os Edge sao idempotentes (re-rodar nao causa efeito duplicado).
-- O disparo HTTP usa pg_net (net.http_post) com o segredo CRON_DISPATCH_SECRET
-- do Vault no header X-Cron-Secret, padrao dos demais crons->Edge do projeto.
-- Idempotente: unschedule antes de schedule; create or replace nas funcoes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- disparar_triagem_descarte() — POST para a Edge triagem-descarte-cron.
-- ---------------------------------------------------------------------
create or replace function public.disparar_triagem_descarte()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/triagem-descarte-cron';
  v_secret text;
  v_req_id bigint;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
  if v_secret is null then
    raise warning 'disparar_triagem_descarte: segredo CRON_DISPATCH_SECRET ausente no Vault';
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

comment on function public.disparar_triagem_descarte() is
  'Dispara o Edge triagem-descarte-cron (descarte fisico de avisos com carencia expirada) via pg_net. Chamado pelo cron diario triagem-descarte.';

revoke all on function public.disparar_triagem_descarte() from public, anon, authenticated;
grant execute on function public.disparar_triagem_descarte() to service_role;

-- ---------------------------------------------------------------------
-- disparar_triagem_favoritar_retry() — POST para a Edge triagem-favoritar-retry.
-- ---------------------------------------------------------------------
create or replace function public.disparar_triagem_favoritar_retry()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/triagem-favoritar-retry';
  v_secret text;
  v_req_id bigint;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
  if v_secret is null then
    raise warning 'disparar_triagem_favoritar_retry: segredo CRON_DISPATCH_SECRET ausente no Vault';
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

comment on function public.disparar_triagem_favoritar_retry() is
  'Dispara o Edge triagem-favoritar-retry (re-tentativa de propagacao de favoritos pendentes) via pg_net. Chamado pelo cron horario triagem-favoritar-retry.';

revoke all on function public.disparar_triagem_favoritar_retry() from public, anon, authenticated;
grant execute on function public.disparar_triagem_favoritar_retry() to service_role;

-- ---------------------------------------------------------------------
-- Agendamento idempotente: unschedule (se existir) antes de schedule.
-- ---------------------------------------------------------------------
do $$
begin
  perform cron.unschedule('triagem-descarte');
exception when others then
  null; -- job ainda nao existe; segue.
end;
$$;

select cron.schedule(
  'triagem-descarte',
  '0 3 * * *',
  $job$ select public.disparar_triagem_descarte(); $job$
);

do $$
begin
  perform cron.unschedule('triagem-favoritar-retry');
exception when others then
  null; -- job ainda nao existe; segue.
end;
$$;

select cron.schedule(
  'triagem-favoritar-retry',
  '0 * * * *',
  $job$ select public.disparar_triagem_favoritar_retry(); $job$
);
