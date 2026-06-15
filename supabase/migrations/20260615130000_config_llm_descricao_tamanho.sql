-- =====================================================================
-- Migration: config_llm — tamanho-alvo da descricao gerada pela IA.
--   Coluna descricao_max_palavras (limite superior de palavras da descricao
--   comercial gerada). Administravel pela tela "Configuracoes da empresa"
--   (card de IA), sem hardcode. Default 40 palavras (~3-4 linhas).
-- =====================================================================

alter table public.config_llm
  add column if not exists descricao_max_palavras int not null default 40;
