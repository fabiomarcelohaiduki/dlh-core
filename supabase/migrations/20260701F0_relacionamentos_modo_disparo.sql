-- =====================================================================
-- Feature: Relacionamentos V2 - Fase 0 (migrations aditivas)
-- Modo de disparo por regra em public.catalogo_regras_vinculo.
--
-- Contexto (roadmap feature-relacionamentos-v2.md §4.5):
--   Cada regra hierarquica passa a ter um modo de disparo que define
--   QUANDO ela vira aresta - escolhido pelo humano por regra (nao global):
--     * 'imediato'  -> roda ao entrar dado novo;
--     * 'agendado'  -> roda em horario configurado (pg_cron atual);
--     * 'on-demand' -> so roda quando o humano clica "executar".
--
-- DEFAULT 'agendado': preserva EXATAMENTE o comportamento atual do
-- pg_cron - todas as regras existentes continuam sendo processadas pelo
-- backfill agendado apos a migration, sem mudanca de conduta.
--
-- Enum logico via text + CHECK (nunca ENUM nativo do Postgres, PRD D.7).
-- Padrao: ADITIVA e IDEMPOTENTE (ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS). Nenhuma policy RLS alterada.
-- =====================================================================

alter table public.catalogo_regras_vinculo
  add column if not exists modo_disparo text not null default 'agendado'
    check (modo_disparo in ('imediato','agendado','on-demand'));

comment on column public.catalogo_regras_vinculo.modo_disparo is
  'Relacionamentos V2: quando a regra vira aresta (imediato|agendado|on-demand). DEFAULT agendado preserva o pg_cron atual (§4.5).';

-- Indice para o disparador selecionar regras por org e modo
-- (ex.: pg_cron pega agendado; borda imediata pega imediato).
create index if not exists idx_catalogo_regras_modo_disparo
  on public.catalogo_regras_vinculo (org_id, modo_disparo);
