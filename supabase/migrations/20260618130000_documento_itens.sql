-- =====================================================================
-- Triagem por ITEM — tabela documento_itens + estado de extracao.
--
-- MUDANCA DE PARADIGMA (decisao Fabio 2026-06-18):
--   A triagem deixa de CRUZAR no servidor (sai busca_produtos_por_documento /
--   produtos_candidatos). O servidor passa a entregar a LISTA DE ITENS do
--   edital; a LIA cruza item x catalogo (raciocinio probabilistico fica na Lia,
--   extracao deterministica fica no servidor).
--
-- POR QUE POR DOCUMENTO (e nao por aviso):
--   Dedup global do acervo: 1 arquivo = 1 entidade (texto+chunks 1x), N vinculos
--   linkam. A extracao de itens e CARA (LLM) -> roda 1x por DOCUMENTO; a fila
--   resolve aviso -> documento_vinculos -> documento_itens. Reaproveita entre os
--   N avisos que compartilham o mesmo edital.
--
-- MULTIPLAS LISTAS convivem (NUNCA fundir): o mesmo edital pode ter a lista no
--   corpo + a lista no anexo TR (uma com preco de referencia, outra sem). Cada
--   lista carrega `lista_origem`. Um unico PDF "edital e anexos" pode conter as
--   duas -> discriminadas por lista_origem dentro do MESMO documento_id.
--
-- FONTE DA DESCRICAO (regra de negocio critica):
--   A "relacao de itens" gerada por PORTAL (Comprasnet/Licitanet/PNCP) traz a
--   descricao GENERICA do portal (= itensEdital do Effecti, NAO confiavel).
--   Marcada fonte_descricao='portal' e NUNCA usada como descricao canonica. O
--   anexo TR traz a descricao tecnica longa -> fonte_descricao='tecnica'. A
--   deteccao e por CONTEUDO no passo de extracao (marcador de portal / CATMAT /
--   descricao = objeto do aviso), NUNCA pelo nome do arquivo (ambiguo).
--
-- Idempotente (if not exists / create or replace), conforme norma de migration.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Tabela de itens extraidos por documento.
-- ---------------------------------------------------------------------
create table if not exists public.documento_itens (
  id              uuid primary key default gen_random_uuid(),
  documento_id    uuid not null references public.documentos(id) on delete cascade,
  -- Discrimina listas distintas dentro do mesmo documento (corpo vs anexo TR).
  -- Rotulo livre vindo do extrator (ex.: 'corpo do edital', 'termo de referencia').
  lista_origem    text not null default 'principal',
  -- 'tecnica' = descricao tecnica do edital/TR (canonica).
  -- 'portal'  = descricao generica do portal (Comprasnet/Licitanet/PNCP) -> NAO
  --             confiavel; conservada para nº/qtd, nunca como descricao boa.
  fonte_descricao text not null default 'tecnica'
                    check (fonte_descricao in ('tecnica', 'portal')),
  -- Identificacao do item no edital. TEXTO LIVRE: heterogeneo ("1", "1.1",
  -- "Item 03", "Lote 2 / Item 5"). Nunca assumir int.
  item_numero     text,
  lote            text,
  -- Descricao INTEGRAL do item (sem corte). Conteudo de NEGOCIO (fronteira SOM
  -- permite; custo/margem/BOM nunca entram aqui).
  descricao       text not null,
  unidade         text,
  quantidade      numeric,
  preco_referencia numeric,
  -- Ordem de aparicao na lista (estabilidade de exibicao/paginacao).
  ordem           int,
  created_at      timestamptz not null default now()
);

comment on table public.documento_itens is
  'Itens de licitacao extraidos (LLM, 1x por documento) do texto de editais/TR. A triagem entrega esta lista; a Lia cruza com o catalogo. Multiplas listas por documento convivem (lista_origem); descricao de portal e marcada fonte_descricao=portal e nao e canonica.';

-- Lookup principal da fila: itens de um documento, em ordem.
create index if not exists documento_itens_documento_idx
  on public.documento_itens (documento_id, ordem);

-- ---------------------------------------------------------------------
-- 2) Estado da extracao de itens, na propria tabela documentos.
--    Espelha o padrao de status terminal da extracao/OCR:
--      pendente  -> ainda nao processado
--      extraido  -> itens gravados (>=1 item)
--      sem_itens -> processado, documento nao contem lista de itens (terminal)
--      erro      -> falha TRANSITORIA (reprocessavel; conta tentativas)
--      inobtenivel -> falha terminal apos teto de tentativas
--      ignorado  -> documento fora de escopo (proposta/ata/nota/imagem) — nao extrai
-- ---------------------------------------------------------------------
alter table public.documentos
  add column if not exists itens_status text not null default 'pendente'
    check (itens_status in
      ('pendente', 'extraido', 'sem_itens', 'erro', 'inobtenivel', 'ignorado'));

alter table public.documentos
  add column if not exists itens_tentativas int not null default 0;

alter table public.documentos
  add column if not exists itens_extraido_em timestamptz;

-- Fila de trabalho do extrator: documentos pendentes/reprocessaveis primeiro.
create index if not exists documentos_itens_status_idx
  on public.documentos (itens_status)
  where itens_status in ('pendente', 'erro');

-- ---------------------------------------------------------------------
-- 3) Acesso: conteudo de NEGOCIO. RLS habilitada; service_role (Edge/extrator)
--    bypassa. A Lia le via SQL read-only amplo (denylist nao cobre estas colunas
--    — sem segredo). Sem policies para anon/authenticated (server-side).
-- ---------------------------------------------------------------------
alter table public.documento_itens enable row level security;
