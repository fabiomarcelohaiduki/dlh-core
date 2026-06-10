-- =====================================================================
-- Migration: Agendamento + disparo manual da fonte DRIVE via GitHub Actions
--
-- Decisao (10/06): o Drive ganha agendamento PROPRIO no cockpit, no mesmo
-- card/relogio das demais fontes (config_ingestao + aplicar_agendamento_fonte),
-- por simetria com Effecti/Nomus/Gmail. Antes a DESCOBERTA do Drive estava
-- embutida no extrator global (extrair-anexos.yml) e dependia do agendamento
-- da EXTRACAO (config_extracao) — global e enganoso. Agora cada fonte coleta no
-- seu workflow proprio: a descoberta do Drive virou coletar-drive.yml (so lista
-- as pastas ativas e enfileira vinculos, sem Tika), e o extrator virou DRAIN
-- puro (consome a fila de todas as fontes).
--
-- A coleta roda no runner Node do GitHub Actions (a credencial Drive e a API do
-- Google so existem la). Por isso o job pg_cron 'coleta-drive' NAO chama o
-- orquestrador Edge: aciona a GitHub REST API para disparar coletar-drive.yml
-- (workflow_dispatch), igual ao Nomus/Gmail.
--
-- Pre-requisito: o Drive precisa de uma linha em `fontes` e em `config_ingestao`
-- para que o AgendamentoFonteForm/Edge (agnosticos, keyed por fonte_id) tenham
-- onde gravar. Esta migration cria ambas de forma idempotente. A credencial real
-- do Drive continua no Vault (refresh token OAuth); a linha `fontes` aqui e so o
-- ANCORA do agendamento (estado 'nao_configurada', token_cifrado=null).
--
-- Reusa o mesmo segredo GITHUB_DISPATCH_TOKEN do Vault usado por Nomus/Gmail.
--
-- Idempotente: create or replace + guards "where not exists". Aplicar via Node
-- `pg` (SUPABASE_DB_URL), padrao do projeto (schema_migrations remoto atrasado).
-- =====================================================================

-- ---------------------------------------------------------------------
-- fontes: linha ANCORA da fonte Drive (so para o agendamento morar nela).
-- estado 'nao_configurada' + token_cifrado null: a credencial vive no Vault,
-- conectada pelo card Drive; esta linha NAO e fonte de credencial. ativa=true,
-- ordem=5 (depois de Effecti=0, Nomus=2, Gmail=4).
-- ---------------------------------------------------------------------
insert into public.fontes (nome, tipo, endpoint_base, estado_conexao, token_cifrado, ativa, ordem)
select 'Google Drive', 'drive', 'https://www.googleapis.com/drive/v3', 'nao_configurada', null, true, 5
where not exists (
  select 1 from public.fontes where tipo = 'drive'
);

-- ---------------------------------------------------------------------
-- config_ingestao: default da fonte Drive. Filtros/janela aqui sao inertes
-- (a descoberta do Drive usa as pastas ativas do cockpit, NAO estes campos);
-- existem so para satisfazer os NOT NULL e ancorar o agendamento. Agendamento
-- inicia DESLIGADO (agendamento_ativo default false, frequencia 'manual') =>
-- nenhum job pg_cron ate o Fabio ligar pelo painel.
-- ---------------------------------------------------------------------
insert into public.config_ingestao (fonte_id, frequencia, horario_referencia, janela_dias, modalidades, portais)
select f.id, 'manual', null, 15, '{}'::text[], '{}'::text[]
from public.fontes f
where f.tipo = 'drive'
  and not exists (
    select 1 from public.config_ingestao c where c.fonte_id = f.id
  );

-- ---------------------------------------------------------------------
-- aplicar_agendamento_fonte(p_fonte_tipo): ramifica por ALVO do disparo.
--   - Nomus + Gmail + Drive: GitHub Actions (workflow_dispatch via REST API).
--     Nomus dispara coletar-nomus.yml (inputs.modo=incremental); Gmail dispara
--     coletar-gmail.yml; Drive dispara coletar-drive.yml (descobre pastas ativas).
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
  -- Nomus/Gmail/Drive: alvo e a GitHub REST API (workflow_dispatch), nao o Edge.
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

  if p_fonte_tipo in ('nomus', 'gmail', 'drive') then
    -- --------------------------------------------------------------
    -- NOMUS/GMAIL/DRIVE: dispara o workflow proprio no GitHub Actions (a
    -- credencial/API da fonte so existe no runner Node). Modo permanente:
    -- Nomus incremental; Gmail monta a query do gmail-config no runner;
    -- Drive descobre as pastas ativas do cockpit. O backfill full do Nomus
    -- segue manual (workflow_dispatch pela UI do Actions).
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
    elsif p_fonte_tipo = 'gmail' then
      v_gh_url  := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-gmail.yml/dispatches';
      v_gh_body := jsonb_build_object('ref', 'master');
    else
      v_gh_url  := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-drive.yml/dispatches';
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
  'Reescreve o job pg_cron coleta-<tipo> a partir da config_ingestao da fonte (horario local UTC-3 -> UTC). Effecti chama o orquestrador Edge; Nomus, Gmail e Drive disparam o workflow GitHub Actions proprio (workflow_dispatch) via GitHub REST API com GITHUB_DISPATCH_TOKEN do Vault. Chamada pelo painel ao salvar o agendamento da fonte.';

revoke all on function public.aplicar_agendamento_fonte(text) from public, anon, authenticated;
grant execute on function public.aplicar_agendamento_fonte(text) to service_role;

-- ---------------------------------------------------------------------
-- disparar_workflow_drive(p_gatilho): disparo MANUAL da coleta do Drive pelo
-- card. SECURITY DEFINER, chamada server-side pela Edge drive-disparar (sessao
-- autorizada + audit). Dispara coletar-drive.yml (workflow_dispatch) no master,
-- descobrindo as pastas ativas. Reusa GITHUB_DISPATCH_TOKEN do Vault.
-- p_gatilho e propagado via inputs.gatilho (manual|agendada) por simetria com
-- Nomus/Gmail (o runner do Drive nao abre execucao, entao e cosmetico hoje, mas
-- mantem o contrato uniforme).
-- ---------------------------------------------------------------------
create or replace function public.disparar_workflow_drive(p_gatilho text default 'manual')
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_gh_url   text := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-drive.yml/dispatches';
  v_gh_token text;
  v_req_id   bigint;
  v_gatilho  text := case when p_gatilho = 'manual' then 'manual' else 'agendada' end;
begin
  select decrypted_secret into v_gh_token
    from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
  if v_gh_token is null then
    raise exception 'segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
  end if;

  select net.http_post(
    url     := v_gh_url,
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_gh_token,
                 'Accept', 'application/vnd.github+json',
                 'X-GitHub-Api-Version', '2022-11-28',
                 'User-Agent', 'dlh-core-cron',
                 'Content-Type', 'application/json'
               ),
    body    := jsonb_build_object(
                 'ref', 'master',
                 'inputs', jsonb_build_object('gatilho', v_gatilho)
               )
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.disparar_workflow_drive(text) is
  'Dispara o workflow GitHub Actions coletar-drive.yml (workflow_dispatch) com inputs.gatilho (manual|agendada): descobre as pastas ativas do Drive e enfileira os vinculos na fila de documentos, independente da extracao. Usa GITHUB_DISPATCH_TOKEN do Vault. Chamada server-side pela Edge drive-disparar (manual).';

revoke all on function public.disparar_workflow_drive(text) from public, anon, authenticated;
grant execute on function public.disparar_workflow_drive(text) to service_role;

-- Estado inicial: re-escreve o job (Drive inicia DESLIGADO => no-op, nenhum job).
select public.aplicar_agendamento_fonte('drive');
