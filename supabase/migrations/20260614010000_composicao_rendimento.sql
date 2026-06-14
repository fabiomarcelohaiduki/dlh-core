-- =====================================================================
-- Rendimento opcional na BOM (sku_composicao)
-- ---------------------------------------------------------------------
-- Quando preenchido, guarda quantas PECAS 1 unidade de material rende
-- (ex.: 1 m2 de dublagem -> 16 mouse pads). A quantidade consumida por
-- peca passa a ser derivada: quantidade = 1 / rendimento. Null = a
-- quantidade foi informada direto (comportamento legado).
--
-- O motor de custo (fn_recalcular_sku) continua usando SOMENTE a coluna
-- quantidade; rendimento e apenas metadado de entrada/edicao para o
-- usuario nao precisar calcular a fracao na mao. Por isso nenhum trigger
-- muda. Idempotente.
-- =====================================================================
alter table public.sku_composicao
  add column if not exists rendimento numeric;

comment on column public.sku_composicao.rendimento is
  'Quando preenchido: quantas pecas 1 unidade de material rende; quantidade = 1/rendimento. Null = quantidade informada direto.';
