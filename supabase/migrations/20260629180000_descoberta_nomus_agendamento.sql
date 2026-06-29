-- =====================================================================
-- Migration: agendamento da DESCOBERTA (enfileiramento) por fonte, dono do
-- cockpit, via pg_cron -> Edge documentos-descobrir (pg_net).
--
-- MOTIVO (29/06): a fila de extracao so enche quando os anexos sao
-- DESCOBERTOS (materializados em documento_vinculos status=pendente). Effecti
-- descobre sozinho pos-coleta (hooks na ingestao), Gmail/Drive ja entregam a
-- lista pronta na coleta — so o NOMUS dependia do botao manual "Trazer para a
-- fila". A descoberta do Nomus e 100% server-side (varre nomus_processos no
-- proprio Supabase e grava documento_vinculos; NAO baixa bytes, NAO usa Tika,
-- NAO usa o PC local), entao o cockpit pode ser dono do relogio: na hora
-- marcada o pg_cron chama a Edge documentos-descobrir (X-Cron-Secret) com
-- {fonte:'nomus'} e ela materializa a fila (idempotente). O botao manual segue
-- como atalho/fallback.
--
-- O QUE ENTRA:
--   1. Tabela config_descoberta (1 linha por fonte; so 'nomus' por ora) com as
--      mesmas colunas de agendamento das demais (ativo, frequencia, horario,
--      dia_semana, dia_mes). Mesmo gate RLS (is_conta_autorizada), audit e
--      updated_at das outras configs. Seed da linha 'nomus' desligada.
--   2. RPC aplicar_agendamento_descoberta(p_fonte): reescreve o job pg_cron
--      'descobrir-<fonte>' a partir da linha (horario local UTC-3 -> UTC). O
--      job chama a Edge documentos-descobrir via net.http_post com o
--      X-Cron-Secret do Vault e body {fonte}. Idempotente (unschedule antes).
--   3. Re-aplica 'nomus' para materializar o estado atual (desligado => no-op).
--
-- Idempotente (if not exists / create or replace). Aplicar via Node `pg`
-- (SUPABASE_DB_URL), padrao do projeto (schema_migrations remoto atrasado).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabela: config_descoberta — 1 linha por fonte descobrivel agendavel.
-- Hoje so 'nomus' (Effecti auto-descobre; Gmail/Drive entregam pronto na
-- coleta). O check trava a fonte; alargar quando outra fonte precisar de
-- relogio proprio de descoberta.
-- ---------------------------------------------------------------------
-- `id` existe porque o trigger de audit (fn_audit_log) registra new.id/old.id;
-- `fonte` segue como chave de negocio (PK), unica por design (1 relogio por
-- fonte) e alvo do upsert onConflict:"fonte" da Edge.
create table if not exists public.config_descoberta (
  id                  uuid not null default gen_random_uuid(),
  fonte               text primary key,
  agendamento_ativo   boolean not null default false,
  frequencia          text not null default 'manual',
  horario_referencia  text,
  dia_semana          int,
  dia_mes             int,
  updated_at          timestamptz,
  constraint config_descoberta_fonte_chk check (fonte in ('nomus'))
);

-- Heal: se uma execucao anterior criou a tabela sem `id` (antes deste ajuste),
-- adiciona a coluna agora (idempotente).
alter table public.config_descoberta
  add column if not exists id uuid not null default gen_random_uuid();

-- ---------------------------------------------------------------------
-- RLS: mesmo gate das outras configs (conta autorizada). O loader le via
-- cliente RLS (sessao do cockpit); o cron escreve via service_role.
-- ---------------------------------------------------------------------
alter table public.config_descoberta enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'config_descoberta'
       and policyname = 'config_descoberta_acesso_autorizado'
  ) then
    create policy config_descoberta_acesso_autorizado on public.config_descoberta
      for all using (public.is_conta_autorizada())
      with check (public.is_conta_autorizada());
  end if;
end$$;

-- ---------------------------------------------------------------------
-- Triggers: audit_log + updated_at (reusa funcoes existentes).
-- ---------------------------------------------------------------------
drop trigger if exists trg_audit_config_descoberta on public.config_descoberta;
create trigger trg_audit_config_descoberta
  after insert or update or delete on public.config_descoberta
  for each row execute function public.fn_audit_log();

drop trigger if exists trg_set_updated_at_config_descoberta on public.config_descoberta;
create trigger trg_set_updated_at_config_descoberta
  before update on public.config_descoberta
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------
-- Seed: linha 'nomus' desligada (singleton por fonte). Idempotente.
-- ---------------------------------------------------------------------
insert into public.config_descoberta (fonte, agendamento_ativo, frequencia)
select 'nomus', false, 'manual'
where not exists (select 1 from public.config_descoberta where fonte = 'nomus');

-- ---------------------------------------------------------------------
-- aplicar_agendamento_descoberta(p_fonte): reescreve o job pg_cron
-- 'descobrir-<fonte>' a partir da linha config_descoberta. O job chama a Edge
-- documentos-descobrir (X-Cron-Secret do Vault) com body {fonte}; a Edge
-- materializa documento_vinculos (descoberta server-side, idempotente). Parse
-- de horario local->UTC e montagem do cron reproduzidos das demais funcoes de
-- agendamento. service_role (chamado pela Edge descoberta-agendamento).
-- ---------------------------------------------------------------------
create or replace function public.aplicar_agendamento_descoberta(p_fonte text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  cfg          public.config_descoberta%rowtype;
  v_job        text := 'descobrir-' || p_fonte;
  v_min        int := 0;
  v_local_h    int := 0;
  v_utc_h      int;
  v_day_shift  int;
  v_dow        int;
  v_expr       text;
  v_url        text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/documentos-descobrir';
  v_secret     text;
  v_body       text;
begin
  select * into cfg from public.config_descoberta where fonte = p_fonte limit 1;

  -- Sempre limpa o job atual antes de (re)agendar (idempotente).
  begin perform cron.unschedule(v_job); exception when others then null; end;

  -- Sem linha, desligado ou manual => nao agenda nada.
  if cfg.fonte is null or cfg.agendamento_ativo is not true or cfg.frequencia = 'manual' then
    return format('agendamento descoberta %s desligado', p_fonte);
  end if;

  -- Parse de 'HH:MM' (default 06:00 quando ausente/invalido — descoberta cedo,
  -- antes da janela de extracao).
  if cfg.horario_referencia ~ '^\d{1,2}:\d{2}$' then
    v_local_h := split_part(cfg.horario_referencia, ':', 1)::int;
    v_min     := split_part(cfg.horario_referencia, ':', 2)::int;
  else
    v_local_h := 6; v_min := 0;
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

  -- Alvo: Edge documentos-descobrir, autenticada pelo X-Cron-Secret do Vault
  -- (gatilho 'agendada' na Edge). Mesmo padrao do cron de coleta Effecti.
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
    $job$, v_url, v_secret, p_fonte);

  perform cron.schedule(v_job, v_expr, v_body);
  return format('agendado descoberta %s: %s (UTC) freq=%s', p_fonte, v_expr, cfg.frequencia);
end;
$fn$;

comment on function public.aplicar_agendamento_descoberta(text) is
  'Reescreve o job pg_cron descobrir-<fonte> a partir da linha config_descoberta (horario local UTC-3 -> UTC). O job chama a Edge documentos-descobrir (X-Cron-Secret do Vault) com body {fonte}, que materializa documento_vinculos (descoberta server-side, idempotente). Chamada pela Edge descoberta-agendamento ao salvar.';

revoke all on function public.aplicar_agendamento_descoberta(text) from public, anon, authenticated;
grant execute on function public.aplicar_agendamento_descoberta(text) to service_role;

-- Materializa o estado atual (linha 'nomus' desligada => no-op).
select public.aplicar_agendamento_descoberta('nomus');
