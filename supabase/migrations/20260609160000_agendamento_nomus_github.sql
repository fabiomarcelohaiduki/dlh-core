-- =====================================================================
-- Migration: Agendamento da fonte NOMUS via GitHub Actions (workflow_dispatch)
--
-- Decisao (09/06): o agendamento do Nomus passa a ser configuravel pelo
-- cockpit, no mesmo card/relogio das demais fontes (config_ingestao +
-- aplicar_agendamento_fonte). A diferenca e o ALVO do disparo: o Nomus NAO
-- coleta pelo Edge (Deno/rustls nao fecha o TLS legado do Nomus), ele roda no
-- runner Node do GitHub Actions. Por isso o job pg_cron 'coleta-nomus', em vez
-- de chamar o orquestrador Edge, chama a GitHub REST API para acionar o
-- workflow 'coletar-nomus.yml' (workflow_dispatch, modo incremental).
--
-- Resultado: o relogio do Nomus deixa de viver no `schedule:` do YAML e passa
-- a ser o pg_cron, reescrito pelo painel ao salvar o agendamento da fonte. O
-- mesmo AgendamentoFonteForm/Edge/Schema (ja agnosticos de fonte) servem ao
-- Nomus sem alteracao; so esta funcao ramifica por fonte.
--
-- Pre-requisito: segredo GITHUB_DISPATCH_TOKEN no Vault (PAT fine-grained com
-- escopo Actions: read+write no repo dlh-core). Sem ele, a funcao retorna erro
-- ao agendar o Nomus (mesma guarda do CRON_DISPATCH_SECRET).
--
-- Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
-- padrao do projeto (schema_migrations remoto intencionalmente atrasado).
-- =====================================================================

create or replace function public.aplicar_agendamento_fonte(p_fonte_tipo text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
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
  -- Nomus: alvo e a GitHub REST API (workflow_dispatch), nao o Edge.
  v_gh_url       text := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-nomus.yml/dispatches';
  v_gh_token     text;
  v_gh_auth      text;
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

  if p_fonte_tipo = 'nomus' then
    -- --------------------------------------------------------------
    -- NOMUS: dispara o workflow do GitHub Actions (runner Node fala o
    -- TLS legado do Nomus, o Edge nao). Modo incremental (regime
    -- permanente); o backfill full segue manual (workflow_dispatch UI).
    -- --------------------------------------------------------------
    select decrypted_secret into v_gh_token
      from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
    if v_gh_token is null then
      return 'erro: segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
    end if;
    v_gh_auth := 'Bearer ' || v_gh_token;

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
        body    := jsonb_build_object(
                     'ref', 'master',
                     'inputs', jsonb_build_object('modo', 'incremental')
                   )
      );
      $job$, v_gh_url, v_gh_auth);
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
$$;

comment on function public.aplicar_agendamento_fonte(text) is
  'Reescreve o job pg_cron coleta-<tipo> a partir da config_ingestao da fonte (horario local UTC-3 -> UTC). Effecti chama o orquestrador Edge; Nomus dispara o workflow GitHub Actions (workflow_dispatch) via GitHub REST API com GITHUB_DISPATCH_TOKEN do Vault. Chamada pelo painel ao salvar o agendamento da fonte.';

revoke all on function public.aplicar_agendamento_fonte(text) from public, anon, authenticated;
grant execute on function public.aplicar_agendamento_fonte(text) to service_role;
