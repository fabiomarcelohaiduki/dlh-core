-- =====================================================================
-- Feature: Relacionamentos V2 - Fase 0 (migrations aditivas)
-- Proveniencia do candidato em public.vinculos_inferidos_lia.
--
-- Contexto (roadmap feature-relacionamentos-v2.md §4.10):
--   Cada candidato/regra inferida carrega sua origem para auditoria e
--   limpeza: quando foi adicionado (data_origem) e em que contexto de
--   uso a Lia o cadastrou (contexto_origem). A coluna origem ('lia' |
--   'humano') ja existe desde a criacao da tabela; estas colunas
--   complementam a proveniencia sem alterar o contrato existente.
--
-- data_origem NOT NULL DEFAULT now(): linhas legadas recebem o momento
-- da migration como origem, mantendo a coluna sempre preenchida.
--
-- Padrao: ADITIVA e IDEMPOTENTE (ADD COLUMN IF NOT EXISTS). Nenhuma
-- policy RLS alterada; o escopo por org_id IN (SELECT current_user_orgs())
-- das policies vinculos_inferidos_lia_* permanece intacto.
-- =====================================================================

alter table public.vinculos_inferidos_lia
  add column if not exists data_origem timestamptz not null default now();

alter table public.vinculos_inferidos_lia
  add column if not exists contexto_origem text null;

comment on column public.vinculos_inferidos_lia.data_origem is
  'Relacionamentos V2: quando o candidato/regra inferida foi adicionado (proveniencia, §4.10).';
comment on column public.vinculos_inferidos_lia.contexto_origem is
  'Relacionamentos V2: contexto de uso que originou o candidato quando adicionado pela Lia (§4.10).';
