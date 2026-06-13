-- ---------------------------------------------------------------------
-- produto_skus.atributos (valores de atributo POR SKU)
-- ---------------------------------------------------------------------
-- O schema de atributos vive na Linha (produto_linha_atributos) e no
-- Produto (produto_atributos). Os VALORES desses atributos passam a ser
-- preenchidos por SKU (cada variante informa os seus). Mapa JSONB livre na
-- forma; a validacao contra o schema mesclado (Linha + Produto) ocorre na
-- Edge. Default '{}' para SKUs existentes.
-- ---------------------------------------------------------------------
alter table public.produto_skus
  add column if not exists atributos jsonb not null default '{}'::jsonb;
