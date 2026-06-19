-- =====================================================================
-- Triagem por ITEM — tabela triagem_item_matches (match item x catalogo).
--
-- POR QUE EXISTE (decisao Fabio 2026-06-19):
--   O servidor NAO cruza edital x catalogo (a Lia cruza, raciocinio
--   probabilistico). O subagente analista-licitacao casa CADA item do edital
--   com um produto do catalogo, mas ate aqui esse match por item era
--   DESCARTADO: so o melhor produto candidato GLOBAL ia para triagem_decisoes
--   (historico). O cockpit precisa exibir, na tabela de itens, QUAL item deu
--   match e com QUAL produto -> o match precisa ser PERSISTIDO por item.
--
-- POR QUE POR AVISO (e nao em documento_itens):
--   documento_itens e POR DOCUMENTO (dedup global: 1 edital -> N avisos). O
--   match e artefato da TRIAGEM (tem score, e uma decisao daquela rodada). Se
--   morasse em documento_itens, o match de um aviso vazaria para todos os
--   avisos que compartilham o mesmo edital. Por isso a chave e (aviso_id,
--   documento_item_id): o item e do documento, mas o match e daquele aviso.
--
-- CICLO DE VIDA:
--   v1-triagem-veredito grava os matches da rodada (delete-then-insert por
--   aviso). Re-triagem (conteudo_hash muda, triagem_veredito zera) regrava.
--   Re-extracao do documento (documento_itens delete-then-insert) cascateia e
--   limpa os matches orfaos. produto/sku deletados -> set null (a linha
--   sobrevive com o nome em snapshot).
--
-- SNAPSHOT: produto_nome guardado junto do produto_id (espelha
--   triagem_decisoes.produto_candidato_nome) -> exibicao resiliente a
--   renomeacao/exclusao do produto, sem join obrigatorio na leitura.
--
-- Idempotente (if not exists). Aplicar via node pg direto (SUPABASE_DB_URL
-- session pooler), NUNCA supabase db push.
-- =====================================================================

create table if not exists public.triagem_item_matches (
  id                uuid primary key default gen_random_uuid(),
  -- A triagem e por aviso: o mesmo item (documento compartilhado) pode ter
  -- match distinto em avisos diferentes.
  aviso_id          uuid not null references public.avisos(id) on delete cascade,
  -- O item especifico do edital que deu match.
  documento_item_id uuid not null references public.documento_itens(id) on delete cascade,
  -- Produto do catalogo casado. SET NULL na exclusao do produto -> a linha
  -- sobrevive com produto_nome (snapshot) para exibicao historica.
  produto_id        uuid references public.produtos(id) on delete set null,
  -- SKU especifico quando o subagente chegou nesse nivel (opcional).
  sku_id            uuid references public.produto_skus(id) on delete set null,
  -- Snapshot do nome do produto no momento do match (resiliencia de exibicao).
  produto_nome      text,
  -- Similaridade do match (0..1) reportada pela busca semantica de catalogo.
  score             numeric,
  created_at        timestamptz not null default now(),
  -- No maximo um match por item dentro de um aviso (o melhor). O write-side faz
  -- delete-then-insert por aviso; a constraint blinda contra duplicata na rodada.
  constraint triagem_item_matches_aviso_item_key unique (aviso_id, documento_item_id)
);

comment on table public.triagem_item_matches is
  'Match item-do-edital x produto-do-catalogo, por AVISO (artefato da triagem da Lia). documento_itens e por documento (dedup global); o match e por aviso para nao vazar entre avisos que compartilham o mesmo edital. produto_nome e snapshot.';

-- Lookup principal do cockpit: matches de um aviso (painel de itens expandido).
create index if not exists triagem_item_matches_aviso_idx
  on public.triagem_item_matches (aviso_id);

-- Acesso: artefato de NEGOCIO (sem segredo). RLS habilitada; service_role
-- (Edge de leitura/escrita) bypassa. A Lia le via SQL read-only amplo. Sem
-- policies para anon/authenticated (acesso server-side).
alter table public.triagem_item_matches enable row level security;
