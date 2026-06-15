-- =====================================================================
-- Migration: config_indexacao — parametros da INDEXACAO (embeddings) dos
--   documentos. Camada que gera chunks/embeddings em memoria_chunks
--   (origem='documento'), separada da EXTRACAO de texto (config_extracao).
--
--   Singleton GLOBAL (uma linha), espelha config_extracao/config_llm:
--   RLS por conta autorizada, triggers audit_log + updated_at, seed
--   idempotente. Administravel pelo cockpit, sem hardcode.
--
--   ativo               master switch da indexacao (default OFF; so liga
--                       quando a key OpenAI estiver no Vault e o Fabio
--                       aprovar o gasto). Governa CONTINUO e BACKFILL.
--   fontes_habilitadas  null = todas; array = somente estas fontes sao
--                       indexadas (gating por documento_vinculos.fonte,
--                       no continuo e no backfill).
--   lote_chunks         ORCAMENTO de chunks por invocacao do backfill (nao
--                       e "N docs": um edital grande pode ter milhares de
--                       chunks; limitar por chunk evita estourar o teto de
--                       wall-clock do Edge).
--   pausa_ms            pausa entre lotes de embeddings (alivia a OpenAI).
--
--   A CHAVE da OpenAI NAO fica aqui: vive cifrada no Vault
--   (LLM_OPENAI_API_KEY), reusada da config de IA. O provider/modelo de
--   embeddings (openai / text-embedding-3-small / dim 1024) vem do env do
--   Edge (EMBEDDINGS_PROVIDER / EMBEDDINGS_DIM) + default no codigo.
--
--   Idempotente: create if not exists / drop if exists. Aplicar via Node
--   `pg` (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

create table if not exists public.config_indexacao (
  id                  uuid primary key default gen_random_uuid(),
  ativo               boolean not null default false,
  fontes_habilitadas  text[],                         -- null = todas
  lote_chunks         int not null default 1500,
  pausa_ms            int not null default 0,
  updated_at          timestamptz
);

-- ---------------------------------------------------------------------
-- RLS: mesmo gate das demais configs (conta autorizada).
-- ---------------------------------------------------------------------
alter table public.config_indexacao enable row level security;
drop policy if exists config_indexacao_acesso_autorizado on public.config_indexacao;
create policy config_indexacao_acesso_autorizado on public.config_indexacao
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- ---------------------------------------------------------------------
-- Triggers: audit_log + updated_at (reusa funcoes existentes).
-- ---------------------------------------------------------------------
drop trigger if exists trg_audit_config_indexacao on public.config_indexacao;
create trigger trg_audit_config_indexacao
  after insert or update or delete on public.config_indexacao
  for each row execute function public.fn_audit_log();

drop trigger if exists trg_set_updated_at_config_indexacao on public.config_indexacao;
create trigger trg_set_updated_at_config_indexacao
  before update on public.config_indexacao
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------
-- Seed: 1 linha default (singleton). Idempotente.
-- ---------------------------------------------------------------------
insert into public.config_indexacao (ativo, fontes_habilitadas, lote_chunks, pausa_ms)
select false, null, 1500, 0
where not exists (select 1 from public.config_indexacao);
