-- =====================================================================
-- Feature: Relacionamentos V2 - F4 (Regras semanticas, 2 blocos)
-- Migration ADITIVA e IDEMPOTENTE que estende public.config_relacionamentos
-- com os parametros de clustering/cap consumidos pela nova experiencia de
-- regras semanticas e pelo grafo 3D (SPEC §2.1.4 / §2.4.3, RF-25):
--
--   * cap_por_grafo (int, NOT NULL DEFAULT 200): teto de nos POR GRAFO.
--     Precede o legado cap_panorama ate o DROP (gate D). Precedencia no
--     codigo: cap_por_grafo ?? cap_panorama ?? 200.
--   * clustering_threshold_nos (int, NOT NULL DEFAULT 80): a partir de
--     quantos nos o grafo agrupa por densidade (clusterizacao).
--   * tipo_default_panorama (text, NOT NULL DEFAULT 'semantico'): tipo de
--     relacionamento default do panorama quando ?tipo= ausente. Enum
--     logico via text + CHECK (PRD §D.7): 'hierarquico' | 'semantico'.
--
-- COEXISTENCIA COM F2: a migration 20260701F2_relacionamentos_config_dois_grafos.sql
-- ja pode ter criado cap_por_grafo (nullable) e tipo_default_panorama
-- (default 'hierarquico'). Como ADD COLUMN IF NOT EXISTS e no-op quando a
-- coluna existe, esta migration RECONCILIA o estado desejado da F4 de forma
-- idempotente:
--   - backfill de cap_por_grafo NULL -> 200 (WHERE ... IS NULL);
--   - ALTER SET DEFAULT / SET NOT NULL em cap_por_grafo;
--   - ALTER SET DEFAULT 'semantico' em tipo_default_panorama (o default F4
--     substitui o 'hierarquico' introduzido pela F2 SEM reescrever valores
--     ja definidos nas linhas existentes).
--
-- Padrao: ADD COLUMN IF NOT EXISTS + backfill protegido por WHERE IS NULL.
-- Nenhuma policy RLS alterada; nenhum dado V1 quebrado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Colunas (IF NOT EXISTS - no-op quando a F2 ja criou cap_por_grafo /
--    tipo_default_panorama).
-- ---------------------------------------------------------------------
alter table public.config_relacionamentos
  add column if not exists cap_por_grafo int not null default 200;

alter table public.config_relacionamentos
  add column if not exists clustering_threshold_nos int not null default 80;

alter table public.config_relacionamentos
  add column if not exists tipo_default_panorama text not null default 'semantico'
    check (tipo_default_panorama in ('hierarquico', 'semantico'));

-- ---------------------------------------------------------------------
-- 2) Backfill idempotente (SPEC §2.4.3): preenche apenas linhas com valores
--    NULL. cap_por_grafo pode nascer NULL quando criado pela F2; as demais
--    colunas sao NOT NULL e nunca ficam NULL (backfill no-op nelas).
-- ---------------------------------------------------------------------
update public.config_relacionamentos
set cap_por_grafo = 200
where cap_por_grafo is null;

update public.config_relacionamentos
set clustering_threshold_nos = 80
where clustering_threshold_nos is null;

update public.config_relacionamentos
set tipo_default_panorama = 'semantico'
where tipo_default_panorama is null;

-- ---------------------------------------------------------------------
-- 3) Reconciliacao de default/nullability para o alvo F4 (idempotente).
--    Necessario quando a F2 criou cap_por_grafo nullable/sem default e
--    tipo_default_panorama com default 'hierarquico'.
-- ---------------------------------------------------------------------
alter table public.config_relacionamentos
  alter column cap_por_grafo set default 200;

alter table public.config_relacionamentos
  alter column cap_por_grafo set not null;

alter table public.config_relacionamentos
  alter column tipo_default_panorama set default 'semantico';

comment on column public.config_relacionamentos.cap_por_grafo is
  'Relacionamentos V2 (F4): teto de nos POR GRAFO. NOT NULL DEFAULT 200. Precedencia: cap_por_grafo ?? cap_panorama ?? 200.';
comment on column public.config_relacionamentos.clustering_threshold_nos is
  'Relacionamentos V2 (F4): numero de nos a partir do qual o grafo agrupa por densidade (clusterizacao). NOT NULL DEFAULT 80.';
comment on column public.config_relacionamentos.tipo_default_panorama is
  'Relacionamentos V2 (F4): tipo de relacionamento default do panorama quando ?tipo= ausente (hierarquico|semantico). NOT NULL DEFAULT semantico.';
