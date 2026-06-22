-- =====================================================================
-- Migration: config_indexacao.embeddings_provider / embeddings_endpoint —
--   torna o PROVIDER de embeddings administravel pelo cockpit, sem hardcode.
--
--   ANTES: resolveEmbeddingProvider() (_shared/indexacao.ts) FORCAVA 'openai'
--   no codigo. Trocar de provider exigia editar o codigo e redeploy. A unica
--   sobra legada (escrita de avisos via createEmbeddingProvider() gated em
--   EMBEDDINGS_ENDPOINT) ja foi migrada; agora o provider vira config.
--
--   embeddings_provider  qual motor gera os embeddings:
--                          'openai'       -> text-embedding-3-small (custo por
--                                            token; chave no Vault
--                                            LLM_OPENAI_API_KEY, NAO aqui).
--                          'bge-m3-local' -> servico self-hosted (sem custo;
--                                            exige embeddings_endpoint).
--                        Default 'openai' = preserva o comportamento atual.
--   embeddings_endpoint  URL do servico self-hosted (so usado por
--                        'bge-m3-local'); null quando 'openai'.
--
--   ATENCAO (recall): trocar o provider muda o ESPACO VETORIAL. Os chunks ja
--   gravados (aviso_chunks / memoria_chunks) ficam incompativeis com a busca
--   ate o acervo ser REINDEXADO. O cockpit avisa; nao ha reindex automatico.
--
--   Idempotente (add column if not exists). Aplicar via Node `pg`
--   (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

alter table public.config_indexacao
  add column if not exists embeddings_provider text not null default 'openai';

alter table public.config_indexacao
  add column if not exists embeddings_endpoint text;

-- Trava os valores aceitos (deterministico; provider invalido nunca grava).
alter table public.config_indexacao
  drop constraint if exists config_indexacao_embeddings_provider_check;
alter table public.config_indexacao
  add constraint config_indexacao_embeddings_provider_check
  check (embeddings_provider in ('openai', 'bge-m3-local'));

comment on column public.config_indexacao.embeddings_provider is
  'Motor de embeddings: openai (text-embedding-3-small, custo, chave no Vault) ou bge-m3-local (self-hosted, sem custo, exige embeddings_endpoint). Trocar exige reindexar o acervo.';
comment on column public.config_indexacao.embeddings_endpoint is
  'URL do servico self-hosted de embeddings (so para bge-m3-local). null quando openai.';
