-- =====================================================================
-- fontes — FLAG DE PRESENCA da credencial do PAINEL WEB da Effecti.
--
-- A integracao da Effecti usa um TOKEN de API (fontes.token_cifrado, ref do
-- Vault). Separadamente, o PAINEL WEB (minha.effecti.com.br) tem login
-- programatico (usuario/senha -> JWT) que abre o endpoint /all com a lista
-- COMPLETA de itens por edital — fonte de recall total que a API de
-- integracao nao entrega (ela so devolve a sublista que casou por palavra-chave).
--
-- A credencial do painel (usuario+senha) vive CIFRADA no Vault como um SEGREDO
-- DE SERVICO pelo nome deterministico EFFECTI_PAINEL_CRED (JSON), seguindo o
-- padrao do LLM_OPENAI_API_KEY (set/get_service_secret). NUNCA fica na tabela
-- nem volta ao cliente (RNF-02). Esta coluna e apenas a FLAG DE PRESENCA:
--   - painel_cred_em: timestamp da ultima gravacao da credencial do painel;
--     null = nao configurado. Espelha o papel de token_cifrado != null para o
--     token de API (a tela deriva `painelConfigurado` desta coluna).
--
-- Aditivo/idempotente. Aplicar via node pg direto (SUPABASE_DB_URL session
-- pooler), NUNCA supabase db push.
-- =====================================================================

alter table public.fontes
  add column if not exists painel_cred_em timestamptz;

comment on column public.fontes.painel_cred_em is
  'Flag de presenca da credencial do painel web (segredo de servico EFFECTI_PAINEL_CRED no Vault). null = nao configurado. O segredo nunca fica na tabela.';
