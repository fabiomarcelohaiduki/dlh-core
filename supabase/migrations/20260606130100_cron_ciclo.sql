-- =====================================================================
-- Migration: pg_cron do CICLO GLOBAL + funcao aplicar_agendamento()
--
-- Substitui o job placeholder no-op por um job real, parametrizado pela
-- config_agendamento (singleton). A funcao aplicar_agendamento() traduz
-- frequencia + horario local (America/Sao_Paulo, UTC-3) em uma expressao
-- cron UTC e (re)agenda o job 'coleta-ciclo', cujo corpo chama a Edge
-- Function ingestao-orquestrar autenticando pelo segredo de sistema do
-- Vault (X-Cron-Secret). Chamada pelo endpoint do painel ao salvar.
-- =====================================================================

-- Disparo HTTP a partir do Postgres (necessario para chamar a Edge Function).
create extension if not exists pg_net;

-- Remove o job placeholder antigo (no-op) se existir; o ciclo agora e
-- governado por 'coleta-ciclo'.
do $$
begin
  perform cron.unschedule('coleta-effecti-agendada');
exception when others then null;
end;
$$;

-- ---------------------------------------------------------------------
-- aplicar_agendamento() — (re)escreve o job 'coleta-ciclo' conforme a
-- config_agendamento. SECURITY DEFINER: o painel (usuario autorizado)
-- chama via RPC, mas o agendamento roda com privilegio do owner.
--
-- Traducao de horario: horario_referencia 'HH:MM' e LOCAL (UTC-3 fixo).
-- UTC = local + 3h. Quando isso cruza a meia-noite, o dia avanca (+1),
-- ajustando dia_semana (mod 7) no caso semanal.
--
-- frequencia:
--   manual  -> sem job (desliga o ciclo)
--   horaria -> '{min} * * * *'          (todo dia, a cada hora, no minuto)
--   diaria  -> '{min} {utc_h} * * *'
--   semanal -> '{min} {utc_h} * * {dow}'
--   mensal  -> '{min} {utc_h} {dom} * *'
-- ---------------------------------------------------------------------
create or replace function public.aplicar_agendamento()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cfg            public.config_agendamento%rowtype;
  v_min          int := 0;
  v_local_h      int := 0;
  v_utc_h        int;
  v_day_shift    int;
  v_dow          int;
  v_expr         text;
  v_url          text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/ingestao-orquestrar';
  v_secret       text;
  v_body         text;
begin
  select * into cfg from public.config_agendamento limit 1;

  -- Sempre limpa o job atual antes de (re)agendar (idempotente).
  begin perform cron.unschedule('coleta-ciclo'); exception when others then null; end;

  -- Desligado ou manual => nao agenda nada.
  if cfg.id is null or cfg.ativo is not true or cfg.frequencia = 'manual' then
    return 'ciclo desligado';
  end if;

  -- Parse de 'HH:MM' (default 07:00 quando ausente/invalido).
  if cfg.horario_referencia ~ '^\d{1,2}:\d{2}$' then
    v_local_h := split_part(cfg.horario_referencia, ':', 1)::int;
    v_min     := split_part(cfg.horario_referencia, ':', 2)::int;
  else
    v_local_h := 7; v_min := 0;
  end if;

  -- Local (UTC-3) -> UTC.
  v_utc_h     := (v_local_h + 3);
  v_day_shift := v_utc_h / 24;       -- 0 ou 1
  v_utc_h     := v_utc_h % 24;

  if cfg.frequencia = 'horaria' then
    v_expr := format('%s * * * *', v_min);
  elsif cfg.frequencia = 'diaria' then
    v_expr := format('%s %s * * *', v_min, v_utc_h);
  elsif cfg.frequencia = 'semanal' then
    v_dow  := (coalesce(cfg.dia_semana, 1) + v_day_shift) % 7;   -- ajuste de dia por UTC
    v_expr := format('%s %s * * %s', v_min, v_utc_h, v_dow);
  elsif cfg.frequencia = 'mensal' then
    v_expr := format('%s %s %s * *', v_min, v_utc_h, coalesce(cfg.dia_mes, 1));
  else
    return 'frequencia desconhecida: ' || cfg.frequencia;
  end if;

  -- Segredo de sistema do Vault (autentica a chamada na Edge Function).
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
  if v_secret is null then
    return 'erro: segredo CRON_DISPATCH_SECRET ausente no Vault';
  end if;

  v_body := format(
    $job$
    select net.http_post(
      url     := %L,
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'X-Cron-Secret', %L
                 ),
      body    := '{}'::jsonb
    );
    $job$, v_url, v_secret);

  perform cron.schedule('coleta-ciclo', v_expr, v_body);
  return format('agendado: %s (UTC) freq=%s', v_expr, cfg.frequencia);
end;
$$;

comment on function public.aplicar_agendamento() is
  'Reescreve o job pg_cron coleta-ciclo a partir de config_agendamento (horario local UTC-3 -> UTC). Chamada pelo painel ao salvar o agendamento.';

-- Acesso a RPC: somente service_role (a Edge Function agendamento-config a
-- invoca server-side). Bloqueia chamada direta por anon/authenticated.
revoke all on function public.aplicar_agendamento() from public, anon, authenticated;
grant execute on function public.aplicar_agendamento() to service_role;

-- Aplica o estado inicial (config seed = desligado => nenhum job criado).
select public.aplicar_agendamento();
