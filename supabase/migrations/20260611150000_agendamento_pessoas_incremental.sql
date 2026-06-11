-- =====================================================================
-- Migration: o agendamento do recurso `pessoas` dispara INCREMENTAL
--
-- Decisao (11/06, Fabio): o cron diario do recurso pessoas deve rodar o
-- modo INCREMENTAL, nao full. Pessoas expoe dataModificacao, entao o
-- incremental ja captura novos (id>marca) E edicoes (2a passada por data)
-- de forma barata — nao ha ganho em re-varrer tudo todo dia (full e caro e
-- so existe p/ processos, que NAO tem data de alteracao e so pegam edicoes
-- re-varrendo a janela). Demais recursos (processos) seguem FULL.
--
-- Unica mudanca em aplicar_agendamento_recurso: o `modo` dos inputs do
-- workflow_dispatch vira condicional por recurso. Idempotente (create or
-- replace). Aplicar via Node `pg` (SUPABASE_DB_URL), o caminho padrao deste
-- projeto.
--
-- O comando do cron CONGELA os inputs na criacao do job, entao a troca da
-- funcao so vale para jobs (re)criados a partir daqui. O recurso pessoas
-- inicia DESLIGADO (sem job), entao recriar a funcao basta; o re-apply de
-- pessoas no fim e no-op enquanto estiver desligado, e ja nasce incremental
-- quando Fabio ligar o agendamento no card.
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
  -- Modo do disparo agendado por recurso: pessoas=incremental (tem
  -- dataModificacao, o incremental ja pega edicoes barato); demais=full.
  v_modo         text;
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
    -- Master switch do recurso: desligado => nenhum cron, mesmo com
    -- agendamento.ativo=true. `ativo` ausente preserva o legado (ligado);
    -- so o valor explicito false desliga (o job ja foi limpo acima).
    if (cfg.recursos -> p_recurso ->> 'ativo')::boolean is false then
      return format('recurso %s desligado', v_job);
    end if;
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
    -- Nomus processos=FULL (varredura deslizante de janela_dias, pega
    -- novos+editados); Nomus pessoas=INCREMENTAL (dataModificacao ja pega
    -- edicoes barato) + recurso (modulo alvo); Gmail monta a query no runner.
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
      v_modo      := case when p_recurso = 'pessoas' then 'incremental' else 'full' end;
      v_gh_inputs := jsonb_build_object('modo', v_modo);
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

-- ---------------------------------------------------------------------
-- Re-aplica o agendamento do Nomus/pessoas para o modo novo valer ja: se
-- estiver ligado, o job 'coleta-nomus-pessoas' nasce/renasce com modo
-- incremental; se desligado (estado atual), e no-op. processos nao precisa
-- de re-apply (segue full, comando inalterado).
-- ---------------------------------------------------------------------
do $reapply$
declare
  v_res text;
begin
  if exists (select 1 from public.fontes where tipo = 'nomus') then
    select public.aplicar_agendamento_recurso('nomus', 'pessoas') into v_res;
    raise notice 'reapply nomus/pessoas pos-incremental: %', v_res;
  end if;
end;
$reapply$;
