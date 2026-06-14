-- =====================================================================
-- Visibilidade de atributo nos documentos (Catalogo / Ficha tecnica)
-- Cada atributo (da Linha e do Produto) ganha duas flags independentes
-- que controlam se ele aparece no Catalogo e/ou na Ficha tecnica. Default
-- true: todo atributo ja existente passa a aparecer nos dois documentos;
-- o usuario desmarca o que nao quiser exibir. Idempotente (if not exists).
-- =====================================================================
alter table public.produto_linha_atributos
  add column if not exists mostra_catalogo boolean not null default true,
  add column if not exists mostra_ficha    boolean not null default true;

alter table public.produto_atributos
  add column if not exists mostra_catalogo boolean not null default true,
  add column if not exists mostra_ficha    boolean not null default true;
