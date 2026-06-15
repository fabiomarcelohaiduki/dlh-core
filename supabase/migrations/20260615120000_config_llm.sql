-- =====================================================================
-- Migration: config_llm — configuracao da IA (LLM) usada nas geracoes
--   assistidas do cockpit (ex: descricao comercial de produto). Segue o
--   padrao de config_empresa: singleton GLOBAL, RLS por conta autorizada,
--   triggers audit_log + updated_at, seed idempotente.
--
--   A CHAVE DA API NAO fica nesta tabela. O segredo vive CIFRADO no Vault
--   (set_service_secret 'LLM_OPENAI_API_KEY') e nunca volta ao cliente. A
--   tabela guarda apenas provider/modelo/ativo (parametros nao-sensiveis,
--   administraveis pela tela "Configuracoes da empresa", sem hardcode).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabela: config_llm
--   provider  provedor da LLM (so 'openai' no MVP; extensivel)
--   modelo    nome do modelo (ex 'gpt-4o-mini')
--   ativo     liga/desliga a geracao assistida (default off; so liga apos
--             a chave estar configurada no Vault)
-- ---------------------------------------------------------------------
create table if not exists public.config_llm (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null default 'openai',
  modelo      text not null default 'gpt-4o-mini',
  ativo       boolean not null default false,
  updated_at  timestamptz
);

-- ---------------------------------------------------------------------
-- RLS: mesmo gate das demais configs (conta autorizada).
-- ---------------------------------------------------------------------
alter table public.config_llm enable row level security;
drop policy if exists config_llm_acesso_autorizado on public.config_llm;
create policy config_llm_acesso_autorizado on public.config_llm
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- ---------------------------------------------------------------------
-- Triggers: audit_log + updated_at (reusa funcoes existentes).
-- ---------------------------------------------------------------------
drop trigger if exists trg_audit_config_llm on public.config_llm;
create trigger trg_audit_config_llm
  after insert or update or delete on public.config_llm
  for each row execute function public.fn_audit_log();

drop trigger if exists trg_set_updated_at_config_llm on public.config_llm;
create trigger trg_set_updated_at_config_llm
  before update on public.config_llm
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------
-- Seed: 1 linha default (singleton). Idempotente.
-- ---------------------------------------------------------------------
insert into public.config_llm (provider, modelo, ativo)
select 'openai', 'gpt-4o-mini', false
where not exists (select 1 from public.config_llm);
