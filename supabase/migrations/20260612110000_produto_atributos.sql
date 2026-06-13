-- =====================================================================
-- produto_atributos (RF-02, US-02 — extensao)
-- Atributos PROPRIOS de um Produto, somados ao schema herdado da Linha.
-- Espelha produto_linha_atributos, mas ancorado no Produto. A validacao
-- do JSONB produtos.atributos passa a aceitar a UNIAO Linha + Produto.
-- chave unica por (produto_id, chave); colisao com a Linha barrada na borda.
-- RLS deferida (autorizacao na borda); updated_at setado pelo Edge.
-- =====================================================================
create table if not exists public.produto_atributos (
  id           uuid primary key default gen_random_uuid(),
  produto_id   uuid not null references public.produtos(id) on delete restrict,
  chave        text not null,
  tipo         text not null default 'texto'
    check (tipo in ('texto', 'numero', 'booleano')),
  obrigatorio  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint produto_atributos_produto_chave_key unique (produto_id, chave)
);

create index if not exists idx_produto_atributos_produto
  on public.produto_atributos (produto_id);
