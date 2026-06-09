-- =====================================================================
-- Migration: Agendamento da fonte GMAIL via GitHub Actions (workflow_dispatch)
--
-- Decisao (09/06): o Gmail ganha agendamento PROPRIO no cockpit, no mesmo
-- card/relogio das demais fontes (config_ingestao + aplicar_agendamento_fonte),
-- por simetria com Effecti/Nomus. A coleta do Gmail roda no runner Node do
-- GitHub Actions (a credencial Gmail e a API do Google so existem la), no
-- workflow PROPRIO coletar-gmail.yml (independente da extracao — decisao
-- 09/06: cada fonte coleta no seu workflow). Por isso o job pg_cron
-- 'coleta-gmail' NAO chama o orquestrador Edge: ele aciona a GitHub REST API
-- para disparar coletar-gmail.yml (workflow_dispatch), igual ao Nomus.
--
-- Pre-requisito (ja satisfeito): o Gmail precisa de uma linha em `fontes` e em
-- `config_ingestao` para que o AgendamentoFonteForm/Edge (agnosticos, keyed por
-- fonte_id) tenham onde gravar. Esta migration cria ambas de forma idempotente.
-- A credencial real do Gmail continua no Vault (GMAIL_REFRESH_TOKEN), conectada
-- pelo card Gmail; a linha `fontes` aqui e so o ANCORA do agendamento (estado
-- 'nao_configurada', token_cifrado=null), nao um 2o lugar de credencial.
--
-- Reusa o mesmo segredo GITHUB_DISPATCH_TOKEN do Vault usado pelo Nomus.
--
-- Idempotente: create or replace + guards "where not exists". Aplicar via Node
-- `pg` (SUPABASE_DB_URL), padrao do projeto (schema_migrations remoto atrasado).
-- =====================================================================

-- ---------------------------------------------------------------------
-- fontes: linha ANCORA da fonte Gmail (so para o agendamento morar nela).
-- estado 'nao_configurada' + token_cifrado null: a credencial vive no Vault
-- (GMAIL_REFRESH_TOKEN), conectada pelo card Gmail; esta linha NAO e fonte de
-- credencial. ativa=true, ordem=4 (depois de Effecti=0 e Nomus=2).
-- ---------------------------------------------------------------------
insert into public.fontes (nome, tipo, endpoint_base, estado_conexao, token_cifrado, ativa, ordem)
select 'Gmail', 'gmail', 'https://gmail.googleapis.com', 'nao_configurada', null, true, 4
where not exists (
  select 1 from public.fontes where tipo = 'gmail'
);

-- ---------------------------------------------------------------------
-- config_ingestao: default da fonte Gmail. Filtros/janela aqui sao inertes
-- (a coleta do Gmail usa data_inicial + labels do gmail_config, NAO estes
-- campos); existem so para satisfazer os NOT NULL e ancorar o agendamento.
-- Agendamento inicia DESLIGADO (agendamento_ativo default false, frequencia
-- 'manual') => nenhum job pg_cron ate o Fabio ligar pelo painel.
-- ---------------------------------------------------------------------
insert into public.config_ingestao (fonte_id, frequencia, horario_referencia, janela_dias, modalidades, portais)
select f.id, 'manual', null, 15, '{}'::text[], '{}'::text[]
from public.fontes f
where f.tipo = 'gmail'
  and not exists (
    select 1 from public.config_ingestao c where c.fonte_id = f.id
  );

-- ---------------------------------------------------------------------
-- aplicar_agendamento_fonte(p_fonte_tipo): ramifica por ALVO do disparo.
--   - Nomus + Gmail: GitHub Actions (workflow_dispatch via GitHub REST API).
--     Nomus dispara coletar-nomus.yml (inputs.modo=incremental); Gmail dispara
--     coletar-gmail.yml (sem inputs; a query vem do gmail-config no runner).
--   - Effecti (demais): orquestrador Edge escopado por {fonte} no corpo.
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
    -- credencial/API da fonte so existe no runner Node). Modo permanente:
    -- Nomus incremental; Gmail monta a query do gmail-config no runner.
    -- O backfill full segue manual (workflow_dispatch pela UI do Actions).
    -- --------------------------------------------------------------
    select decrypted_secret into v_gh_token
      from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
    if v_gh_token is null then
      return 'erro: segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
    end if;
    v_gh_auth := 'Bearer ' || v_gh_token;

    if p_fonte_tipo = 'nomus' then
      v_gh_url  := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-nomus.yml/dispatches';
      v_gh_body := jsonb_build_object('ref', 'master', 'inputs', jsonb_build_object('modo', 'incremental'));
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
$$;

comment on function public.aplicar_agendamento_fonte(text) is
  'Reescreve o job pg_cron coleta-<tipo> a partir da config_ingestao da fonte (horario local UTC-3 -> UTC). Effecti chama o orquestrador Edge; Nomus e Gmail disparam o workflow GitHub Actions proprio (workflow_dispatch) via GitHub REST API com GITHUB_DISPATCH_TOKEN do Vault. Chamada pelo painel ao salvar o agendamento da fonte.';

revoke all on function public.aplicar_agendamento_fonte(text) from public, anon, authenticated;
grant execute on function public.aplicar_agendamento_fonte(text) to service_role;
