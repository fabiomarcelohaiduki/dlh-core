-- =====================================================================
-- Sprint: Substrato de dados (secao 2 da SPEC)
-- Migration 01/08: Extensoes
-- Habilita as extensoes exigidas pelo substrato unico Supabase (RNF-13/RNF-14).
--   - pgvector  (vector): busca semantica / embeddings HNSW (US-18, RF-21, RNF-09)
--   - pgcrypto: gen_random_uuid() para PKs UUID
--   - pg_cron: agendamento da coleta (US-03, RF-04)
-- =====================================================================

-- pgvector: tipo vector + indices ANN (HNSW). Em PostgreSQL limpo basta a
-- extensao estar disponivel (criterio: "banco PostgreSQL limpo com pgvector
-- habilitado").
create extension if not exists vector;

-- pgcrypto: fornece gen_random_uuid() usado nos defaults das PKs.
create extension if not exists pgcrypto;

-- pg_cron: agendador interno do PostgreSQL (disponivel no Supabase).
-- Requer shared_preload_libraries = 'pg_cron' no servidor (ja habilitado no Supabase).
create extension if not exists pg_cron;
