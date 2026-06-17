-- =====================================================================
-- Migration: config_busca — parametros da BUSCA semantica do acervo,
--   especificamente do RERANKING (camada de qualidade pos-vetorial).
--
--   Fluxo: a busca vetorial (HNSW cosine) traz `rerank_candidatos` chunks;
--   o reranker (Cohere) reordena por relevancia real query+trecho; a Edge
--   devolve os top-N, onde N = o `limite` que a query pediu (default 10).
--   O top-N NAO mora aqui de proposito: ja e o limite do consumidor.
--
--   Singleton GLOBAL (uma linha), espelha config_indexacao/config_extracao:
--   RLS por conta autorizada, triggers audit_log + updated_at, seed
--   idempotente. Administravel pelo cockpit, sem hardcode.
--
--   rerank_ativo       master switch do rerank (default ON). OFF => a Edge
--                      cai no comportamento vetorial puro (sem chamar Cohere).
--                      Permite A/B ao vivo (liga/desliga sem deploy).
--   rerank_modelo      modelo Cohere (default 'rerank-v3.5', multilingue PT).
--   rerank_candidatos  quantos chunks o vetorial traz ANTES do rerank. Cap
--                      [1,50] casa com o teto da RPC busca_semantica_documentos.
--                      Mais candidatos = mais recall pro reranker reordenar.
--
--   A CHAVE da Cohere NAO fica aqui: vive cifrada no Vault
--   (COHERE_RERANK_API_KEY), lida server-side pela Edge. Nunca volta ao cliente.
--
--   Idempotente: create if not exists. Aplicar via Node `pg`
--   (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

create table if not exists public.config_busca (
  id                uuid primary key default gen_random_uuid(),
  rerank_ativo      boolean not null default true,
  rerank_modelo     text not null default 'rerank-v3.5',
  rerank_candidatos int not null default 50
    check (rerank_candidatos between 1 and 50),
  updated_at        timestamptz
);

-- ---------------------------------------------------------------------
-- RLS: mesmo gate das demais configs (conta autorizada).
-- ---------------------------------------------------------------------
alter table public.config_busca enable row level security;
drop policy if exists config_busca_acesso_autorizado on public.config_busca;
create policy config_busca_acesso_autorizado on public.config_busca
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- ---------------------------------------------------------------------
-- Triggers: audit_log + updated_at (reusa funcoes existentes).
-- ---------------------------------------------------------------------
drop trigger if exists trg_audit_config_busca on public.config_busca;
create trigger trg_audit_config_busca
  after insert or update or delete on public.config_busca
  for each row execute function public.fn_audit_log();

drop trigger if exists trg_set_updated_at_config_busca on public.config_busca;
create trigger trg_set_updated_at_config_busca
  before update on public.config_busca
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------
-- Seed: 1 linha default (singleton). Idempotente.
-- ---------------------------------------------------------------------
insert into public.config_busca (rerank_ativo, rerank_modelo, rerank_candidatos)
select true, 'rerank-v3.5', 50
where not exists (select 1 from public.config_busca);
