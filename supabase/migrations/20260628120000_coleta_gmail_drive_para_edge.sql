-- =====================================================================
-- Migration: coleta de GMAIL e DRIVE migra do GitHub Actions para o Edge.
--
-- MOTIVO (28/06): o billing da conta fabiomarcelohaiduki bloqueou o GitHub
-- Actions (pagamento pendente) -> todos os workflows morrem em ~2s. A coleta de
-- Gmail e Drive e LEVE (so descobre/enfileira, sem bytes nem Tika) e o OAuth ja
-- vive cifrado no Vault (Edge gmail-oauth/drive-oauth troca o refresh por um
-- access_token). Por isso a descoberta foi PORTADA para Edge Deno nativo
-- (gmail-coletar / drive-coletar), no mesmo modelo do Effecti: pg_cron -> Edge
-- com X-Cron-Secret. O Nomus CONTINUA no GitHub Actions (TLS CBC legado nao
-- conecta do Deno); a extracao (Tika) tambem segue fora deste escopo.
--
-- O QUE MUDA:
--   1. aplicar_agendamento_fonte: gmail e drive saem do ramo GitHub e passam a
--      chamar a Edge propria (gmail-coletar / drive-coletar) com X-Cron-Secret +
--      {gatilho:'agendada'}. Nomus permanece no ramo GitHub. Effecti inalterado.
--   2. disparar_workflow_gmail / disparar_workflow_drive (disparo MANUAL pelo
--      card, via Edge gmail-disparar/drive-disparar): repointadas para a Edge
--      propria com {gatilho:'manual'}. Mantem assinatura (text -> bigint) e o
--      retorno do net.http_post (request id) para nao quebrar os chamadores.
--
-- Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
-- padrao do projeto (schema_migrations remoto atrasado).
-- =====================================================================

-- ---------------------------------------------------------------------
-- aplicar_agendamento_fonte(p_fonte_tipo): ramifica por ALVO do disparo.
--   - Nomus: GitHub Actions (workflow_dispatch via REST API) — TLS legado.
--   - Effecti + Gmail + Drive: Edge nativo com X-Cron-Secret. Effecti chama
--     ingestao-orquestrar com {fonte}; Gmail/Drive chamam a Edge de coleta
--     propria (gmail-coletar/drive-coletar) com {gatilho:'agendada'}.
-- Mantem a traducao de horario local (UTC-3) -> UTC e a montagem do cron.
-- ---------------------------------------------------------------------
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
  v_base         text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/';
  v_edge_url     text;
  v_edge_body    jsonb;
  v_secret       text;
  v_body         text;
  -- Nomus: alvo e a GitHub REST API (workflow_dispatch), nao o Edge.
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

  if p_fonte_tipo = 'nomus' then
    -- --------------------------------------------------------------
    -- NOMUS: dispara o workflow proprio no GitHub Actions (TLS CBC legado
    -- nao conecta do Deno -> a coleta segue no runner Node). Modo
    -- incremental; backfill full segue manual pela UI do Actions.
    -- --------------------------------------------------------------
    select decrypted_secret into v_gh_token
      from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
    if v_gh_token is null then
      return 'erro: segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
    end if;
    v_gh_auth := 'Bearer ' || v_gh_token;
    v_gh_url  := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-nomus.yml/dispatches';
    v_gh_body := jsonb_build_object('ref', 'master', 'inputs', jsonb_build_object('modo', 'incremental'));

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
    -- EFFECTI / GMAIL / DRIVE: Edge nativo com X-Cron-Secret. Effecti vai ao
    -- orquestrador escopado por {fonte}; Gmail/Drive vao a Edge de coleta
    -- propria, que abre a execucao (lock-por-fonte) e roda a descoberta em
    -- background.
    -- --------------------------------------------------------------
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
    if v_secret is null then
      return 'erro: segredo CRON_DISPATCH_SECRET ausente no Vault';
    end if;

    if p_fonte_tipo = 'gmail' then
      v_edge_url  := v_base || 'gmail-coletar';
      v_edge_body := jsonb_build_object('gatilho', 'agendada');
    elsif p_fonte_tipo = 'drive' then
      v_edge_url  := v_base || 'drive-coletar';
      v_edge_body := jsonb_build_object('gatilho', 'agendada');
    else
      v_edge_url  := v_base || 'ingestao-orquestrar';
      v_edge_body := jsonb_build_object('fonte', p_fonte_tipo);
    end if;

    v_body := format(
      $job$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'X-Cron-Secret', %L
                   ),
        body    := %L::jsonb
      );
      $job$, v_edge_url, v_secret, v_edge_body::text);
  end if;

  perform cron.schedule(v_job, v_expr, v_body);
  return format('agendado %s: %s (UTC) freq=%s', p_fonte_tipo, v_expr, cfg.frequencia);
end;
$$;

comment on function public.aplicar_agendamento_fonte(text) is
  'Reescreve o job pg_cron coleta-<tipo> a partir da config_ingestao da fonte (horario local UTC-3 -> UTC). Effecti, Gmail e Drive chamam Edge nativo com X-Cron-Secret (ingestao-orquestrar / gmail-coletar / drive-coletar); Nomus dispara o workflow GitHub Actions (TLS legado). Chamada pelo painel ao salvar o agendamento da fonte.';

revoke all on function public.aplicar_agendamento_fonte(text) from public, anon, authenticated;
grant execute on function public.aplicar_agendamento_fonte(text) to service_role;

-- ---------------------------------------------------------------------
-- disparar_workflow_gmail(p_gatilho): disparo MANUAL pelo card Gmail, via Edge
-- gmail-disparar (sessao autorizada + audit). Repointada do GitHub para a Edge
-- gmail-coletar com X-Cron-Secret + {gatilho}. Mantem a assinatura/retorno
-- (bigint = request id do net.http_post) para nao quebrar a Edge chamadora.
-- ---------------------------------------------------------------------
create or replace function public.disparar_workflow_gmail(p_gatilho text default 'manual')
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_edge_url text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/gmail-coletar';
  v_secret   text;
  v_req_id   bigint;
  v_gatilho  text := case when p_gatilho = 'agendada' then 'agendada' else 'manual' end;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
  if v_secret is null then
    raise exception 'segredo CRON_DISPATCH_SECRET ausente no Vault';
  end if;

  select net.http_post(
    url     := v_edge_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'X-Cron-Secret', v_secret
               ),
    body    := jsonb_build_object('gatilho', v_gatilho)
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.disparar_workflow_gmail(text) is
  'Dispara a Edge gmail-coletar (X-Cron-Secret + {gatilho}): descobre as mensagens do Gmail (query do gmail-config) e enfileira na fila de documentos, em background. Usa CRON_DISPATCH_SECRET do Vault. Chamada server-side pela Edge gmail-disparar (manual).';

revoke all on function public.disparar_workflow_gmail(text) from public, anon, authenticated;
grant execute on function public.disparar_workflow_gmail(text) to service_role;

-- ---------------------------------------------------------------------
-- disparar_workflow_drive(p_gatilho): disparo MANUAL pelo card Drive, via Edge
-- drive-disparar. Repointada do GitHub para a Edge drive-coletar com
-- X-Cron-Secret + {gatilho}. Mantem assinatura/retorno (bigint = request id).
-- ---------------------------------------------------------------------
create or replace function public.disparar_workflow_drive(p_gatilho text default 'manual')
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_edge_url text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/drive-coletar';
  v_secret   text;
  v_req_id   bigint;
  v_gatilho  text := case when p_gatilho = 'agendada' then 'agendada' else 'manual' end;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
  if v_secret is null then
    raise exception 'segredo CRON_DISPATCH_SECRET ausente no Vault';
  end if;

  select net.http_post(
    url     := v_edge_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'X-Cron-Secret', v_secret
               ),
    body    := jsonb_build_object('gatilho', v_gatilho)
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.disparar_workflow_drive(text) is
  'Dispara a Edge drive-coletar (X-Cron-Secret + {gatilho}): descobre as pastas ativas do Drive e enfileira os vinculos na fila de documentos, em background. Usa CRON_DISPATCH_SECRET do Vault. Chamada server-side pela Edge drive-disparar (manual).';

revoke all on function public.disparar_workflow_drive(text) from public, anon, authenticated;
grant execute on function public.disparar_workflow_drive(text) to service_role;

-- Re-escreve os jobs existentes para o novo alvo (Edge). Se a fonte estiver
-- desligada, e no-op (nenhum job); se ligada, o job ja passa a chamar a Edge.
select public.aplicar_agendamento_fonte('gmail');
select public.aplicar_agendamento_fonte('drive');
