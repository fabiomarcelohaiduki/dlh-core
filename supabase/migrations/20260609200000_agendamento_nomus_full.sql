-- =====================================================================
-- Migration: agendamento diario do Nomus passa a disparar modo FULL
--
-- Decisao (09/06, opcao A): o regime diario permanente do Nomus deve fazer
-- a VARREDURA DESLIZANTE de 365 dias (full), nao o incremental por watermark.
-- Motivo: o Nomus NAO tem dataAlteracao -> processos MODIFICADOS so sao
-- capturados re-varrendo a janela e comparando hash (o que o modo full faz com
-- config_ingestao.recursos.processos.janela_dias). O incremental (id > marca)
-- so traz processos NOVOS e nunca detecta edicoes de processos existentes.
--
-- Unica mudanca vs 20260609160000/190000: o ramo nomus de
-- aplicar_agendamento_fonte monta inputs.modo='full' (era 'incremental').
-- Gmail e Effecti inalterados. Idempotente (create or replace).
-- Aplicar via Node `pg` (SUPABASE_DB_URL) + re-rodar a fn p/ reescrever o cron.
-- =====================================================================

create or replace function public.aplicar_agendamento_fonte(p_fonte_tipo text)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_fonte_id     uuid;
  cfg            public.config_ingestao%rowtype;
  v_job          text := 'coleta-' || p_fonte_tipo;
  v_min          int := 0;
  v_local_h      int := 0;
  v_utc_h        int;
  v_day_shift    int;
  v_dow          int;
  v_expr         text;
  v_url          text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/ingestao-orquestrar';
  v_secret       text;
  v_body         text;
  -- Nomus/Gmail: alvo e a GitHub REST API (workflow_dispatch), nao o Edge.
  v_gh_url       text;
  v_gh_token     text;
  v_gh_auth      text;
  v_gh_body      jsonb;
begin
  -- Resolve a fonte pelo tipo e carrega a config de ingestao dela.
  select id into v_fonte_id from public.fontes where tipo = p_fonte_tipo limit 1;
  if v_fonte_id is null then
    return format('fonte desconhecida: %s', p_fonte_tipo);
  end if;
  select * into cfg from public.config_ingestao where fonte_id = v_fonte_id limit 1;

  -- Sempre limpa o job atual antes de (re)agendar (idempotente).
  begin perform cron.unschedule(v_job); exception when others then null; end;

  -- Desligado ou manual => nao agenda nada.
  if cfg.id is null or cfg.agendamento_ativo is not true or cfg.frequencia = 'manual' then
    return format('agendamento %s desligado', p_fonte_tipo);
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

  if p_fonte_tipo in ('nomus', 'gmail') then
    -- --------------------------------------------------------------
    -- NOMUS/GMAIL: dispara o workflow proprio no GitHub Actions (a
    -- credencial/API da fonte so existe no runner Node). Regime diario:
    -- Nomus FULL (varredura deslizante de janela_dias, pega novos+editados);
    -- Gmail monta a query do gmail-config no runner.
    -- O backfill historico completo (sem janela) segue manual pelo card.
    -- --------------------------------------------------------------
    select decrypted_secret into v_gh_token
      from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
    if v_gh_token is null then
      return 'erro: segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
    end if;
    v_gh_auth := 'Bearer ' || v_gh_token;

    if p_fonte_tipo = 'nomus' then
      v_gh_url  := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-nomus.yml/dispatches';
      v_gh_body := jsonb_build_object('ref', 'master', 'inputs', jsonb_build_object('modo', 'full'));
    else
      v_gh_url  := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-gmail.yml/dispatches';
      v_gh_body := jsonb_build_object('ref', 'master');
    end if;

    v_body := format(
      $job$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object(
                     'Authorization', %L,
                     'Accept', 'application/vnd.github+json',
                     'X-GitHub-Api-Version', '2022-11-28',
                     'User-Agent', 'dlh-core-cron',
                     'Content-Type', 'application/json'
                   ),
        body    := %L::jsonb
      );
      $job$, v_gh_url, v_gh_auth, v_gh_body::text);
  else
    -- --------------------------------------------------------------
    -- DEMAIS FONTES (Effecti): chamam o orquestrador Edge, que escopa a
    -- coleta pela fonte recebida no corpo. Comportamento inalterado.
    -- --------------------------------------------------------------
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
        body    := jsonb_build_object('fonte', %L)
      );
      $job$, v_url, v_secret, p_fonte_tipo);
  end if;

  perform cron.schedule(v_job, v_expr, v_body);
  return format('agendado %s: %s (UTC) freq=%s', p_fonte_tipo, v_expr, cfg.frequencia);
end;
$fn$;
