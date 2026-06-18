-- ---------------------------------------------------------------------
-- Adiciona o nivel 'sku' as tabelas de cotacao e politica.
-- Motivacao: SKUs do mesmo produto podem ter regras OPOSTAS (ex.: MOUSE PAD
-- gel cota quando o edital pede gel; MOUSE PAD plano cota quando NAO pede
-- ergonomico). O nivel produto/linha nao distingue -> precisamos de SKU.
-- escopo_id passa a referenciar produto_skus.id quando nivel='sku' (FK logica).
-- Precedencia de resolucao: SKU > PRODUTO > LINHA.
-- Idempotente: drop+add do check.
-- ---------------------------------------------------------------------

alter table public.cotacao_diretrizes
  drop constraint if exists cotacao_diretrizes_nivel_check;
alter table public.cotacao_diretrizes
  add constraint cotacao_diretrizes_nivel_check
  check (nivel in ('linha', 'produto', 'sku'));

alter table public.cotacao_regras
  drop constraint if exists cotacao_regras_nivel_check;
alter table public.cotacao_regras
  add constraint cotacao_regras_nivel_check
  check (nivel in ('linha', 'produto', 'sku'));

alter table public.politica_participacao
  drop constraint if exists politica_participacao_nivel_check;
alter table public.politica_participacao
  add constraint politica_participacao_nivel_check
  check (nivel in ('linha', 'produto', 'sku'));
