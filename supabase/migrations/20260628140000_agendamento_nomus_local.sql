-- =====================================================================
-- Migration: agendamento do NOMUS passa a ser dono do COCKPIT, via fila.
--
-- MOTIVO (28/06): a coleta Nomus migrou para o PC local (TLS CBC legado nao
-- conecta do Deno) e seu relogio vivia no Agendador de Tarefas do Windows —
-- fora do cockpit, hardcode na maquina. O cockpit so exibia um aviso "roda no
-- PC". Agora o cockpit volta a ser dono da cadencia: o pg_cron, na hora
-- marcada, ENFILEIRA o comando na fila comando_local (mesma fila do disparo
-- manual); o servico de poll do PC pega e executa o coletar-nomus.ps1. Sem
-- GitHub Actions (billing bloqueado) e sem Edge (a Edge nao fala com o Nomus).
--
-- O QUE MUDA:
--   1. enfileirar_comando_local(p_comando): INSERT idempotente na fila
--      comando_local (nao acumula se ja ha um do mesmo comando pendente ou
--      executando). Alvo do cron de Nomus.
--   2. aplicar_agendamento_recurso: o ramo 'nomus' deixa de chamar a GitHub
--      REST API e passa a enfileirar 'nomus-<recurso>' na fila. Gmail (ramo
--      legado, hoje inerte — gmail real agenda via aplicar_agendamento_fonte
--      Edge) e Effecti permanecem inalterados.
--   3. Re-aplica nomus/processos e nomus/pessoas para reescrever os jobs cron
--      existentes para o novo alvo (no-op se a fonte estiver desligada).
--
-- Idempotente (create or replace). Aplicar via Node `pg` (SUPABASE_DB_URL),
-- padrao do projeto (schema_migrations remoto atrasado).
-- =====================================================================

-- ---------------------------------------------------------------------
-- enfileirar_comando_local(p_comando): poe um comando na fila comando_local
-- para o PC executar. Idempotente por comando: se ja existe um 'pendente' ou
-- 'executando' do mesmo comando, NAO enfileira outro (evita acumulo quando o
-- PC esta desligado e o cron dispara varias vezes). Retorna o id criado ou
-- null quando suprimido pela anti-duplicacao. service_role (chamado pelo cron).
-- ---------------------------------------------------------------------
create or replace function public.enfileirar_comando_local(p_comando text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if exists (
    select 1 from public.comando_local
     where comando = p_comando
       and status in ('pendente', 'executando')
  ) then
    return null;
  end if;

  insert into public.comando_local (comando, status, solicitado_por)
  values (p_comando, 'pendente', 'pg_cron')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.enfileirar_comando_local(text) is
  'Enfileira um comando na fila comando_local para o PC local executar, de forma idempotente (nao duplica se ja ha um pendente/executando do mesmo comando). Usado pelo pg_cron de Nomus (coleta-nomus-<recurso>) e disponivel para qualquer agendamento de tarefa local.';

revoke all on function public.enfileirar_comando_local(text) from public, anon, authenticated;
grant execute on function public.enfileirar_comando_local(text) to service_role;

-- ---------------------------------------------------------------------
-- aplicar_agendamento_recurso: o ramo 'nomus' agora enfileira na fila local.
-- O resto da funcao (parse de horario local->UTC, montagem do cron, ramos
-- gmail/effecti) e reproduzido fielmente da versao 09/06 + 28/06.
-- ---------------------------------------------------------------------
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
  v_job          text := 'coleta-' || p_fonte_tipo
                         || coalesce('-' || p_recurso, '');
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
  -- Gmail (ramo legado): alvo e a GitHub REST API.
  v_gh_url       text;
  v_gh_token     text;
  v_gh_auth      text;
  v_gh_body      jsonb;
begin
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

  if p_fonte_tipo = 'nomus' then
    -- --------------------------------------------------------------
    -- NOMUS: roda no PC local (TLS legado). O cron ENFILEIRA o comando na
    -- fila comando_local (idempotente); o servico de poll do PC pega e roda
    -- o coletar-nomus.ps1 do recurso. Sem GitHub Actions e sem Edge.
    -- --------------------------------------------------------------
    if p_recurso is null then
      return 'nomus exige recurso (processos|pessoas) para agendar';
    end if;
    v_body := format(
      $job$ select public.enfileirar_comando_local(%L); $job$,
      'nomus-' || p_recurso
    );
  elsif p_fonte_tipo = 'gmail' then
    -- --------------------------------------------------------------
    -- GMAIL (ramo legado/inerte): o gmail real agenda via
    -- aplicar_agendamento_fonte (Edge gmail-coletar). Mantido por seguranca.
    -- --------------------------------------------------------------
    select decrypted_secret into v_gh_token
      from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
    if v_gh_token is null then
      return 'erro: segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
    end if;
    v_gh_auth := 'Bearer ' || v_gh_token;
    v_gh_url  := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-gmail.yml/dispatches';
    v_gh_body := jsonb_build_object('ref', 'master');

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

comment on function public.aplicar_agendamento_recurso(text, text) is
  'Reescreve o job pg_cron coleta-<fonte>[-<recurso>] a partir do agendamento da config_ingestao (horario local UTC-3 -> UTC). Nomus enfileira na fila comando_local (PC local executa); Effecti chama Edge ingestao-orquestrar; Gmail (legado) dispara GitHub Actions. Chamado pela Edge agendamento-fonte-config ao salvar.';

-- Reescreve os jobs existentes para o novo alvo (fila). Se a fonte/recurso
-- estiver desligado, e no-op; se ligado, o job ja passa a enfileirar.
select public.aplicar_agendamento_recurso('nomus', 'processos');
select public.aplicar_agendamento_recurso('nomus', 'pessoas');
