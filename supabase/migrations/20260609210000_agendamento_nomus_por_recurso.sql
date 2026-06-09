-- =====================================================================
-- Migration: agendamento do Nomus passa a ser POR RECURSO (modulo)
--
-- Decisao (09/06, "separe de verdade"): a stack inteira de coleta do Nomus
-- (cron, workflow, RPC, lock, config, frontend) vira POR RECURSO. Hoje so
-- 'processos' tem coletor/endpoint/mapper vivos; os outros 5 modulos
-- (cobranca/propostas/pedidos/nfes/contas_a_receber) ficam INERTES ate
-- existir API real. Effecti e Gmail sao fontes de modulo unico e NAO mudam.
--
-- O agendamento por recurso vive em config_ingestao.recursos.<recurso>.agendamento
-- (jsonb), separado do agendamento por-fonte (colunas top-level), que segue
-- valido para Effecti/Gmail. O job pg_cron passa a se chamar
-- 'coleta-<fonte>-<recurso>' (ex: coleta-nomus-processos); o antigo
-- 'coleta-nomus' (sem recurso) e aposentado.
--
-- Estrategia: nova fn aplicar_agendamento_recurso(p_fonte_tipo, p_recurso);
-- p_recurso null = caminho legado (colunas top-level, job 'coleta-<fonte>').
-- aplicar_agendamento_fonte(text) vira wrapper fino (chama com recurso null),
-- preservando os agendamentos de Effecti/Gmail sem reescrita.
--
-- Idempotente (create or replace). Aplicar via Node `pg` (SUPABASE_DB_URL).
-- ORDEM EM PRODUCAO: o input 'recurso' do workflow precisa estar no master
-- ANTES do cron disparar (GitHub recusa input inesperado com 422).
-- =====================================================================

create or replace function public.aplicar_agendamento_recurso(
  p_fonte_tipo text,
  p_recurso    text default null
)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_fonte_id     uuid;
  cfg            public.config_ingestao%rowtype;
  -- Job por recurso quando ha recurso; por fonte quando null (legado).
  v_job          text := 'coleta-' || p_fonte_tipo
                         || coalesce('-' || p_recurso, '');
  -- Agendamento efetivo: das colunas top-level (recurso null) ou do jsonb
  -- recursos.<recurso>.agendamento (recurso presente).
  v_ag           jsonb;
  v_ativo        boolean;
  v_freq         text;
  v_horario      text;
  v_dia_semana   int;
  v_dia_mes      int;
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
  v_gh_inputs    jsonb;
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

  if cfg.id is null then
    return format('config ausente para %s', p_fonte_tipo);
  end if;

  -- Carrega o agendamento efetivo conforme o escopo.
  if p_recurso is null then
    v_ativo      := cfg.agendamento_ativo;
    v_freq       := cfg.frequencia;
    v_horario    := cfg.horario_referencia;
    v_dia_semana := cfg.dia_semana;
    v_dia_mes    := cfg.dia_mes;
  else
    v_ag         := cfg.recursos -> p_recurso -> 'agendamento';
    v_ativo      := coalesce((v_ag ->> 'ativo')::boolean, false);
    v_freq       := v_ag ->> 'frequencia';
    v_horario    := v_ag ->> 'horario_referencia';
    v_dia_semana := nullif(v_ag ->> 'dia_semana', '')::int;
    v_dia_mes    := nullif(v_ag ->> 'dia_mes', '')::int;
  end if;

  -- Desligado ou manual => nao agenda nada.
  if v_ativo is not true or v_freq is null or v_freq = 'manual' then
    return format('agendamento %s desligado', v_job);
  end if;

  -- Parse de 'HH:MM' (default 07:00 quando ausente/invalido).
  if v_horario ~ '^\d{1,2}:\d{2}$' then
    v_local_h := split_part(v_horario, ':', 1)::int;
    v_min     := split_part(v_horario, ':', 2)::int;
  else
    v_local_h := 7; v_min := 0;
  end if;

  -- Local (UTC-3) -> UTC.
  v_utc_h     := (v_local_h + 3);
  v_day_shift := v_utc_h / 24;       -- 0 ou 1
  v_utc_h     := v_utc_h % 24;

  if v_freq = 'horaria' then
    v_expr := format('%s * * * *', v_min);
  elsif v_freq = 'diaria' then
    v_expr := format('%s %s * * *', v_min, v_utc_h);
  elsif v_freq = 'semanal' then
    v_dow  := (coalesce(v_dia_semana, 1) + v_day_shift) % 7;   -- ajuste de dia por UTC
    v_expr := format('%s %s * * %s', v_min, v_utc_h, v_dow);
  elsif v_freq = 'mensal' then
    v_expr := format('%s %s %s * *', v_min, v_utc_h, coalesce(v_dia_mes, 1));
  else
    return 'frequencia desconhecida: ' || v_freq;
  end if;

  if p_fonte_tipo in ('nomus', 'gmail') then
    -- --------------------------------------------------------------
    -- NOMUS/GMAIL: dispara o workflow proprio no GitHub Actions (a
    -- credencial/API da fonte so existe no runner Node). Regime diario:
    -- Nomus FULL (varredura deslizante de janela_dias, pega novos+editados)
    -- + recurso (modulo alvo); Gmail monta a query do gmail-config no runner.
    -- O backfill historico completo (sem janela) segue manual pelo card.
    -- --------------------------------------------------------------
    select decrypted_secret into v_gh_token
      from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
    if v_gh_token is null then
      return 'erro: segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
    end if;
    v_gh_auth := 'Bearer ' || v_gh_token;

    if p_fonte_tipo = 'nomus' then
      v_gh_url    := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-nomus.yml/dispatches';
      v_gh_inputs := jsonb_build_object('modo', 'full');
      if p_recurso is not null then
        v_gh_inputs := v_gh_inputs || jsonb_build_object('recurso', p_recurso);
      end if;
      v_gh_body := jsonb_build_object('ref', 'master', 'inputs', v_gh_inputs);
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
  return format('agendado %s: %s (UTC) freq=%s', v_job, v_expr, v_freq);
end;
$fn$;

-- aplicar_agendamento_fonte(text) vira wrapper fino (recurso null = legado).
-- Mantem a assinatura de 1 arg usada por Effecti/Gmail (Edge/RPC existentes).
create or replace function public.aplicar_agendamento_fonte(p_fonte_tipo text)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $wrap$
begin
  return public.aplicar_agendamento_recurso(p_fonte_tipo, null);
end;
$wrap$;

-- ---------------------------------------------------------------------
-- SEED + CORTE: migra o agendamento do Nomus das colunas top-level para
-- recursos.processos.agendamento e troca o cron 'coleta-nomus' pelo
-- 'coleta-nomus-processos'. Idempotente.
-- ---------------------------------------------------------------------
do $seed$
declare
  v_fonte_id uuid;
  cfg        public.config_ingestao%rowtype;
  v_ag       jsonb;
  v_res      text;
begin
  select id into v_fonte_id from public.fontes where tipo = 'nomus' limit 1;
  if v_fonte_id is null then
    return;
  end if;
  select * into cfg from public.config_ingestao where fonte_id = v_fonte_id limit 1;
  if cfg.id is null then
    return;
  end if;

  -- Constroi o agendamento do recurso a partir das colunas atuais da fonte,
  -- SEM sobrescrever se ja existir um agendamento por recurso.
  if (cfg.recursos -> 'processos' -> 'agendamento') is null then
    v_ag := jsonb_strip_nulls(jsonb_build_object(
      'ativo',              coalesce(cfg.agendamento_ativo, false),
      'frequencia',         coalesce(cfg.frequencia, 'manual'),
      'horario_referencia', cfg.horario_referencia,
      'dia_semana',         cfg.dia_semana,
      'dia_mes',            cfg.dia_mes
    ));

    update public.config_ingestao
       set recursos = jsonb_set(
             coalesce(recursos, '{}'::jsonb),
             '{processos,agendamento}',
             v_ag,
             true
           )
     where id = cfg.id;
  end if;

  -- Aposenta o cron por-fonte do Nomus e (re)cria o por-recurso.
  begin perform cron.unschedule('coleta-nomus'); exception when others then null; end;
  select public.aplicar_agendamento_recurso('nomus', 'processos') into v_res;
  raise notice 'seed agendamento nomus/processos: %', v_res;
end;
$seed$;
