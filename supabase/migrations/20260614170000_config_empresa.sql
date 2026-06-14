-- =====================================================================
-- Migration: config_empresa — dados institucionais da DLH usados no
--   cabecalho/rodape da TABELA DE PRECOS em PDF (e demais documentos
--   gerados pelo cockpit). Administravel pela tela "Configuracoes da
--   empresa", sem hardcode.
--
--   Singleton GLOBAL (uma linha). Segue o padrao de config_extracao:
--   RLS por conta autorizada, triggers audit_log + updated_at, seed
--   idempotente. A logo e guardada como data URL base64 na propria linha
--   (decisao: sem bucket de Storage; 1 logo pequena embeda direto no PDF).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabela: config_empresa
--   logo_base64           data URL completa (ex 'data:image/png;base64,...')
--   validade_padrao_dias  validade default da tabela de precos (dias)
--   observacao_rodape     texto livre impresso no rodape do PDF
-- ---------------------------------------------------------------------
create table if not exists public.config_empresa (
  id                    uuid primary key default gen_random_uuid(),
  razao_social          text,
  nome_fantasia         text,
  cnpj                  text,
  inscricao_estadual    text,
  endereco              text,
  telefone              text,
  email                 text,
  site                  text,
  logo_base64           text,
  validade_padrao_dias  int not null default 30,
  observacao_rodape     text,
  updated_at            timestamptz
);

-- ---------------------------------------------------------------------
-- RLS: mesmo gate das demais configs (conta autorizada).
-- ---------------------------------------------------------------------
alter table public.config_empresa enable row level security;
drop policy if exists config_empresa_acesso_autorizado on public.config_empresa;
create policy config_empresa_acesso_autorizado on public.config_empresa
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- ---------------------------------------------------------------------
-- Triggers: audit_log + updated_at (reusa funcoes existentes).
-- ---------------------------------------------------------------------
drop trigger if exists trg_audit_config_empresa on public.config_empresa;
create trigger trg_audit_config_empresa
  after insert or update or delete on public.config_empresa
  for each row execute function public.fn_audit_log();

drop trigger if exists trg_set_updated_at_config_empresa on public.config_empresa;
create trigger trg_set_updated_at_config_empresa
  before update on public.config_empresa
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------
-- Seed: 1 linha default (singleton). Idempotente.
-- ---------------------------------------------------------------------
insert into public.config_empresa (validade_padrao_dias)
select 30
where not exists (select 1 from public.config_empresa);
