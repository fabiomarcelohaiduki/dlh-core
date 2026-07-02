-- =====================================================================
-- Feature: Relacionamentos (GraphLink)
-- Indice em relacoes.chave para suportar as consultas por proveniencia.
--
-- Motivacao: a `chave` de proveniencia (ex.: 'regra_macro:<id>',
-- 'fk:<tabela>:<id>', 'triagem_item_matches:<id>') passou a ser filtrada
-- em DOIS caminhos quentes:
--   1) relacionamentos-dry-run: head count das arestas ja atribuidas a uma
--      regra (contarExistentesDaRegra) para o alerta de duplicidade.
--   2) PODA por regra (novo): DELETE from relacoes WHERE chave='regra_macro:<id>'
--      ao desativar, editar os campos de match, remover ou reativar uma regra.
--
-- Sem o indice, ambos fazem seq scan em `relacoes`. O volume hoje e pequeno,
-- mas a poda vira operacao recorrente do ciclo de vida das regras, entao o
-- indice e a decisao limpa (nao gambiarra) e barata.
--
-- Padrao: ADITIVO e IDEMPOTENTE. Nao altera nenhuma coluna nem dado.
-- =====================================================================

create index if not exists idx_relacoes_chave
  on public.relacoes (chave);
