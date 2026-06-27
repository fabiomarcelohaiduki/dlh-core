-- =====================================================================
-- aviso_itens_portal — lista COMPLETA de itens do edital pelo painel Effecti.
--
-- POR QUE EXISTE (decisao Fabio 2026-06-22):
--   O painel Effecti (/all) entrega a lista NUMERADA COMPLETA do edital. A
--   descricao e GENERICA do portal (CATMAT, com tags de match, precos zerados)
--   -> deve ser LISTADA mas NAO e confiavel. A fonte CONFIAVEL e documento_itens
--   (tabela do edital/TR, descricao tecnica real). Esta tabela materializa a
--   lista do painel para exibicao no cockpit (filtro "lista Effecti") sem
--   misturar com documento_itens (preserva a assimetria do gate de recall, que
--   compara documento_itens vs a lista do /all).
--
-- COLETA: standalone, fora da triagem. O Edge effecti-painel-itens chama
--   coletarItensPainel(/all) e grava aqui. NAO roda dentro do gate de recall.
--
-- SNAPSHOT: a /all e uma foto completa do edital. Cada recoleta SUBSTITUI a
--   lista inteira do effecti_id (delete + insert atomico). Sem versionamento.
--
-- Idempotente (if not exists), conforme norma de migration.
-- =====================================================================

create table if not exists public.aviso_itens_portal (
  id           uuid primary key default gen_random_uuid(),
  -- Chave natural do /all e do join com avisos.effecti_id (NAO o uuid do aviso).
  effecti_id   text not null,
  -- O /all e sempre numerado 1..N (contiguo quando recall integro).
  item_numero  int not null,
  -- Grupo/lote quando o edital divide por lotes; null quando nao ha.
  lote         text,
  -- Descricao GENERICA do portal (CATMAT). LISTADA mas NAO confiavel; a
  -- descricao canonica vem de documento_itens (edital/TR).
  descricao    text not null,
  unidade      text,
  quantidade   numeric,
  -- numeracao 1..N sem buraco/duplicata = sinal de recall integro na coleta.
  contigua     boolean not null default false,
  coletado_em  timestamptz not null default now()
);

comment on table public.aviso_itens_portal is
  'Lista COMPLETA de itens do edital coletada do painel Effecti (/all). Descricao GENERICA do portal -> LISTADA mas NAO confiavel; fonte confiavel = documento_itens (edital/TR). Snapshot por effecti_id, substituido a cada recoleta. Coleta standalone (effecti-painel-itens), fora da triagem.';

-- Anti-duplicata dentro do snapshot. lote nullable -> coalesce no indice unico
-- (Postgres trata null como distinto em unique por padrao).
create unique index if not exists aviso_itens_portal_chave_idx
  on public.aviso_itens_portal (effecti_id, coalesce(lote, ''), item_numero);

-- Lookup principal: lista de um aviso pelo effecti_id.
create index if not exists aviso_itens_portal_effecti_idx
  on public.aviso_itens_portal (effecti_id);

-- Acesso server-side: RLS habilitada, service_role (Edge coletor) bypassa.
-- Sem policies para anon/authenticated (igual documento_itens).
alter table public.aviso_itens_portal enable row level security;
