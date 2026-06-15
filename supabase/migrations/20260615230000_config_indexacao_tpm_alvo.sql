-- =====================================================================
-- Migration: config_indexacao.tpm_alvo — teto de TOKENS POR MINUTO que o
--   backfill da indexacao mira ao chamar a OpenAI.
--
--   PROBLEMA: a pausa fixa (pausa_ms) entre lotes e CEGA a tokens. Com lotes
--   de ~32 chunks (~16k tokens) a cada ~1s, a taxa real encosta no teto de
--   1.000.000 TPM do tier 1 da OpenAI -> 429 sustentado derruba documentos
--   grandes (a causa raiz de "lento E ainda erra").
--
--   SOLUCAO: o backfill passa a ESPACAR cada request pelo numero de tokens
--   que ele carrega (pacer por tokens em documentos-indexar), mirando esta
--   taxa. Default 800.000 (80% do teto: margem para o burst). Administravel
--   pelo cockpit, sem hardcode (espelha lote_chunks / pausa_ms).
--
--   Idempotente (add column if not exists). Aplicar via Node `pg`
--   (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

alter table public.config_indexacao
  add column if not exists tpm_alvo int not null default 800000;

comment on column public.config_indexacao.tpm_alvo is
  'Teto de tokens/min que o backfill mira na OpenAI (pacer por tokens). 0 = sem pacing. Default 800000 (80% do tier 1).';
