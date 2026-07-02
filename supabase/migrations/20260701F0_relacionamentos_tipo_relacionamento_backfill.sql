-- =====================================================================
-- Feature: Relacionamentos V2 - Fase 0 (migrations aditivas)
-- Backfill deterministico de relacoes.tipo_relacionamento.
--
-- Classifica as arestas legadas conforme a coluna metodo:
--   * metodo='deterministico' -> tipo_relacionamento='hierarquico'
--     (arestas estruturais e de match campo-a-campo do backfill V1).
--   * metodo='sugerido'       -> tipo_relacionamento='semantico'
--     (arestas propostas/inferidas).
--
-- Idempotencia: a clausula WHERE tipo_relacionamento='semantico'
-- (valor do DEFAULT recem-adicionado) garante que so as linhas ainda
-- NAO reclassificadas sejam tocadas. Rodar esta migration duas vezes
-- seguidas nao altera o resultado:
--   * o 1o UPDATE promove deterministico->hierarquico; na 2a execucao
--     essas linhas ja nao casam com tipo_relacionamento='semantico'.
--   * o 2o UPDATE apenas confirma 'semantico' onde ja e 'semantico'
--     (no-op efetivo sob o DEFAULT), mantendo a intencao explicita.
--
-- Depende de ..._tipo_relacionamento.sql (coluna criada antes).
-- NAO dropa nada, nao altera policies.
-- =====================================================================

-- deterministico -> hierarquico (arestas estruturais / match campo-a-campo)
update public.relacoes
set tipo_relacionamento = 'hierarquico'
where metodo = 'deterministico'
  and tipo_relacionamento = 'semantico';

-- sugerido -> semantico (arestas propostas / inferidas)
update public.relacoes
set tipo_relacionamento = 'semantico'
where metodo = 'sugerido'
  and tipo_relacionamento = 'semantico';
