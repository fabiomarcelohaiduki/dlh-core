-- =====================================================================
-- Libera as colunas BULK para a Lia na camada SQL (read-only).
--
-- Decisao Fabio [2026-06-18]: expandir o acesso SQL da Lia para alcancar
-- TAMBEM as colunas bulk hoje fora da camada SQL (embedding, texto,
-- payload_bruto, conteudo_verbatim, texto_extraido, conteudo, logo_base64).
-- Objetivo imediato: a Lia diagnosticar a saude da indexacao (ex: embedding
-- nulo) e raciocinar sobre o substrato sem depender de tool externa.
--
-- TEMPORARIO: restringir novamente (re-aplicar a denylist de bulk da
-- 20260615300000) ANTES do go-live de producao real.
--
-- Fronteira DETERMINISTICA do SOM MANTIDA:
--   SEGREDO  = NUNCA. token_cifrado e qualquer coluna que case o regex de
--              segredo continuam FORA, cortadas pelo sweep fail-closed
--              lia_reconcile_segredos() (regex secret|token|senha|password|
--              cifrado|api_key|refresh_token). O event trigger segue ativo.
--   oauth_state (CSRF transitorio) = continua revogado (nao e bulk).
--
-- Demais travas da RPC executar_sql_lia INTACTAS: SELECT/WITH-only, sem ';',
-- LIMIT 1000, statement_timeout 5s, owner read-only lia_sql, so service_role.
--
-- Idempotente. Aplicar via Node `pg` (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

-- 1. Reconcede SELECT em TODAS as colunas de TODAS as tabelas do public.
--    Isto desfaz a denylist de bulk (passo 3 da 20260615300000) reabrindo
--    embedding/texto/payload/verbatim/conteudo/base64. Tambem reabre, de
--    passagem, as colunas de segredo -> o passo 2 as corta de volta.
grant select on all tables in schema public to lia_sql;

-- 2. Sweep fail-closed: corta novamente APENAS as colunas de nome de segredo
--    (token_cifrado em fontes, e qualquer outra que case o regex). Bulk nao
--    casa o regex -> permanece liberado. Funcao ja existente e idempotente.
select public.lia_reconcile_segredos();

-- 3. oauth_state nao e bulk e nao tem valor de negocio -> permanece fora.
revoke select on public.drive_oauth_state from lia_sql;
revoke select on public.gmail_oauth_state from lia_sql;

comment on function public.executar_sql_lia(text, int) is
  'Tool #4 RAG: executa um SELECT read-only da Lia sobre o substrato (schema public + views curadas lia.*) sob travas deterministicas (owner lia_sql read-only; SELECT/WITH-only; sem ";"; statement_timeout 5s; LIMIT 1000). BULK (texto/payload/verbatim/embedding/base64) LIBERADO temporariamente [2026-06-18, decisao Fabio] - restringir antes de producao. Segredo (token_cifrado, oauth_state) segue FORA por GRANT + sweep fail-closed. Vault/cron/auth/storage inalcancaveis. Autorizacao na borda; somente service_role executa.';
