-- =====================================================================
-- Migration: config_extracao.fontes_habilitadas — allowlist de FONTES da
--   camada 1. Singleton GLOBAL (mesma linha de config_extracao).
--
--   null  = TODAS as fontes (default; futuro-prova para fontes novas)
--   array = somente estas fontes entram na fila de extracao
--
--   Onde age: o Edge documentos-ingerir (action='pendentes') filtra os
--   vinculos por documento_vinculos.fonte IN (...) quando ha allowlist.
--   Filtrar na ORIGEM da fila (e nao no runner) evita loop: vinculos de
--   fonte desabilitada simplesmente nao saem como pendentes ao runner.
-- =====================================================================

alter table public.config_extracao
  add column if not exists fontes_habilitadas text[];   -- null = todas
