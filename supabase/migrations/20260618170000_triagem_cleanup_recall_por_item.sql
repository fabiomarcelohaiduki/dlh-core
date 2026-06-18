-- =====================================================================
-- Limpeza pos-RECALL POR ITEM (2026-06-18).
--
-- M2) Remove a RPC busca_produtos_por_documento: ficou MORTA quando a fila
--     parou de cruzar edital x catalogo no servidor (a Lia cruza agora). Nenhum
--     Edge a referencia; so a migration de criacao + scripts de dryrun.
--
-- B4) Promove o indice (nivel, escopo_id) de politica_participacao a UNIQUE:
--     a precedencia sku>produto>linha pressupoe NO MAXIMO uma politica por
--     (nivel, escopo). Sem a constraint, duplicata silenciosa faria o
--     loadPoliticaMap escolher uma linha arbitraria. Blindagem na origem.
--
-- Idempotente (drop if exists / if not exists). Aplicar via node pg direto
-- (SUPABASE_DB_URL session pooler), NUNCA supabase db push.
-- =====================================================================

-- M2 -------------------------------------------------------------------
drop function if exists public.busca_produtos_por_documento(uuid, double precision, int);

-- B4 -------------------------------------------------------------------
-- O indice nao-unico vira redundante: a unique constraint cria o seu proprio.
drop index if exists public.idx_politica_participacao_nivel_escopo;

alter table public.politica_participacao
  drop constraint if exists politica_participacao_nivel_escopo_key;
alter table public.politica_participacao
  add constraint politica_participacao_nivel_escopo_key
  unique (nivel, escopo_id);
