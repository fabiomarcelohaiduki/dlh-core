-- =====================================================================
-- Feature Nomus Processos (Sprint: Pipeline de coleta / orquestrador)
-- Migration: marca temporal da ultima coleta concluida por fonte.
--
-- Alteracao ADITIVA e idempotente: adiciona fontes.ultima_coleta_em, usada
-- pelo orquestrador para registrar quando o ciclo de uma fonte concluiu
-- (RF-20/secao 2.1). Nenhuma coluna/constraint existente e tocada e nenhum
-- novo agendador e criado (reaproveita pg_cron/config_agendamento).
-- =====================================================================

alter table public.fontes
  add column if not exists ultima_coleta_em timestamptz;
