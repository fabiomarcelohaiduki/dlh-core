-- =====================================================================
-- Limpeza de RPCs órfãs do resumo de indexação (zero código órfão).
--
-- A guia "Indexação" da Coleta passou a ler a lista mestra paginada via
-- vw_indexacao_registros + indexacao_registros_listar/contagens (migration
-- 20260629210000). Com isso, a tela antiga /ingestao/indexacao e suas
-- contagens-foto foram removidas, e estas 3 funções ficaram SEM caller:
--
--   - resumo_indexacao(text[])        contagem por status (documentos).
--   - resumo_indexacao_avisos()       contagem por status (avisos Effecti).
--   - resumo_indexacao_processos()    já era órfã (nunca teve caller).
--
-- DROP defensivo (if exists). Não toca nenhuma view/função viva.
-- Aplicar via Node `pg` (SUPABASE_DB_URL), padrão do projeto.
-- =====================================================================

drop function if exists public.resumo_indexacao(text[]);
drop function if exists public.resumo_indexacao_avisos();
drop function if exists public.resumo_indexacao_processos();
