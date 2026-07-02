-- =====================================================================
-- Feature: Relacionamentos V2 - F3 (dry-run de regra + guarda de ativacao)
--
-- Migration ADITIVA e IDEMPOTENTE que estende public.config_relacionamentos
-- com os limiares SOFT (avisos) configuraveis por org usados pela Edge
-- relacionamentos-dry-run para calcular o score_risco de uma regra.
--
-- Os limiares SOFT apenas AVISAM (score_risco.nivel='aviso'), NUNCA
-- bloqueiam a ativacao. O bloqueio (nivel='bloqueio') e reservado ao
-- limite tecnico DURO (volume projetado > 50000 ou timeout de 30s),
-- que e hardcoded na Edge (RNF-12), nao configuravel por org.
--
-- Chaves do jsonb (todos numericos):
--   * confianca_baixa      -> arestas com confianca abaixo deste valor
--                             disparam o alerta de confianca baixa (0..1).
--   * cardinalidade_alta   -> contagem_total acima deste valor dispara o
--                             alerta de cardinalidade alta.
--   * duplicidade_pct      -> fracao (0..1) de arestas ja existentes acima
--                             da qual dispara o alerta de duplicidade.
--   * amostra_insuficiente -> contagem_total abaixo deste valor dispara o
--                             alerta de amostra insuficiente.
--
-- Padrao: ADD COLUMN IF NOT EXISTS (nao dropa nada, nao quebra dados V1,
-- nao altera policies). O DEFAULT preenche as linhas existentes; a coluna
-- e NOT NULL para garantir que a Edge sempre tenha limiares aplicaveis.
-- =====================================================================

alter table public.config_relacionamentos
  add column if not exists dry_run_limiares jsonb not null default
    '{"confianca_baixa":0.5,"cardinalidade_alta":1000,"duplicidade_pct":0.2,"amostra_insuficiente":5}'::jsonb;

comment on column public.config_relacionamentos.dry_run_limiares is
  'Relacionamentos V2 (F3): limiares SOFT do dry-run por org (confianca_baixa, cardinalidade_alta, duplicidade_pct, amostra_insuficiente). Apenas AVISAM (nivel=aviso); nunca bloqueiam. O bloqueio duro (volume>50000 / timeout 30s) e hardcoded na Edge.';
