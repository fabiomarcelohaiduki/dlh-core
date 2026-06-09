-- =====================================================================
-- Migration: Agendamento da EXTRACAO (camada 1) via GitHub Actions.
--
-- Decisao (09/06): o extrator de anexos (workflow extrair-anexos.yml) tinha o
-- cron de drain REMOVIDO de proposito (controle manual). Reintroduzimos o
-- agendamento, mas AGORA configuravel pelo cockpit (liga/desliga sem deploy,
-- horario local, cortavel no painel) em vez do `schedule:` fixo no YAML.
--
-- O extrator NAO e uma fonte (drena fila, nao coleta de origem), entao o
-- agendamento dele NAO entra em config_ingestao/aplicar_agendamento_fonte. Mora
-- no singleton config_extracao (mesma linha dos parametros do Tika) e tem RPC
-- propria. O alvo do disparo e a GitHub REST API (workflow_dispatch) do
-- extrair-anexos.yml, reusando GITHUB_DISPATCH_TOKEN do Vault (mesmo PAT do
-- Nomus/Gmail).
--
-- Colunas de agendamento espelham as de config_ingestao (agendamento_ativo,
-- frequencia, horario_referencia, dia_semana, dia_mes). As colunas de
-- PARAMETROS (ocr_*, timeout, lote...) seguem intocadas e sao gravadas por um
-- PUT separado (extracao-config) — separar config de agendamento evita o bug
-- de um form sobrescrever a coluna do outro (armadilha do Effecti).
--
-- Inicia DESLIGADO (agendamento_ativo=false): nenhum job ate o Fabio ligar no
-- painel. Seed default = diaria 23:00 BRT (depois das coletas Effecti/Nomus).
--
-- Idempotente: if not exists / create or replace. Aplicar via Node `pg`
-- (SUPABASE_DB_URL), padrao do projeto (schema_migrations remoto atrasado).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Colunas de agendamento no singleton config_extracao.
-- dia_semana (0-6) so vale em 'semanal'; dia_mes (1-28) so em 'mensal'.
-- A linha seed ja existe; ADD com default preenche-a.
-- ---------------------------------------------------------------------
alter table public.config_extracao
  add column if not exists agendamento_ativo boolean not null default false;

alter table public.config_extracao
  add column if not exists frequencia text not null default 'diaria';

alter table public.config_extracao
  add column if not exists horario_referencia text not null default '23:00';

alter table public.config_extracao
  add column if not exists dia_semana int;

alter table public.config_extracao
  add column if not exists dia_mes int;

-- ---------------------------------------------------------------------
-- aplicar_agendamento_extracao() — (re)escreve o job pg_cron 'extrair-anexos'
-- a partir do singleton config_extracao. SECURITY DEFINER: o painel (usuario
-- autorizado) chama via RPC; o agendamento roda com privilegio do owner.
-- Traducao de horario local (UTC-3) -> UTC identica a aplicar_agendamento_fonte.
-- O corpo do job dispara o workflow extrair-anexos.yml (workflow_dispatch) via
-- GitHub REST API com GITHUB_DISPATCH_TOKEN do Vault (igual ao ramo Nomus).
-- ---------------------------------------------------------------------
create or replace function public.aplicar_agendamento_extracao()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cfg          public.config_extracao%rowtype;
  v_job        text := 'extrair-anexos';
  v_min        int := 0;
  v_local_h    int := 0;
  v_utc_h      int;
  v_day_shift  int;
  v_dow        int;
  v_expr       text;
  v_body       text;
  v_gh_url     text := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/extrair-anexos.yml/dispatches';
  v_gh_token   text;
  v_gh_auth    text;
begin
  -- Singleton: 1 linha.
  select * into cfg from public.config_extracao limit 1;

  -- Sempre limpa o job atual antes de (re)agendar (idempotente).
  begin perform cron.unschedule(v_job); exception when others then null; end;

  -- Desligado ou manual => nao agenda nada.
  if cfg.id is null or cfg.agendamento_ativo is not true or cfg.frequencia = 'manual' then
    return 'agendamento extracao desligado';
  end if;

  -- Parse de 'HH:MM' (default 23:00 quando ausente/invalido).
  if cfg.horario_referencia ~ '^\d{1,2}:\d{2}$' then
    v_local_h := split_part(cfg.horario_referencia, ':', 1)::int;
    v_min     := split_part(cfg.horario_referencia, ':', 2)::int;
  else
    v_local_h := 23; v_min := 0;
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

  -- Alvo: workflow_dispatch do extrair-anexos.yml (runner Node drena a fila).
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
      body    := jsonb_build_object('ref', 'master')
    );
    $job$, v_gh_url, v_gh_auth);

  perform cron.schedule(v_job, v_expr, v_body);
  return format('agendado extracao: %s (UTC) freq=%s', v_expr, cfg.frequencia);
end;
$$;

comment on function public.aplicar_agendamento_extracao() is
  'Reescreve o job pg_cron extrair-anexos a partir do singleton config_extracao (horario local UTC-3 -> UTC). Dispara o workflow GitHub Actions extrair-anexos.yml (workflow_dispatch) via GitHub REST API com GITHUB_DISPATCH_TOKEN do Vault. Chamada pelo painel ao salvar o agendamento da extracao.';

revoke all on function public.aplicar_agendamento_extracao() from public, anon, authenticated;
grant execute on function public.aplicar_agendamento_extracao() to service_role;

-- Estado inicial: extracao inicia DESLIGADA (agendamento_ativo default false)
-- => nenhum job criado ate o Fabio ligar pelo painel.
select public.aplicar_agendamento_extracao();
