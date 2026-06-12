-- =====================================================================
-- Migration: Schema do dominio Produtos (secao 2.1 da SPEC - Modulo Produtos)
--   Cria as 17 tabelas novas do dominio Produtos no schema public:
--   hierarquia Linha -> Produto/Familia -> Variante/SKU, insumos e precos,
--   parametros de calculo, precos calculados, revenda, diretrizes/regras
--   de cotacao e politica de participacao.
--
--   ESCOPO DESTA SPRINT (001a): SOMENTE a estrutura - colunas, tipos,
--   defaults, FKs (ON DELETE RESTRICT), CHECKs, UNIQUEs e indices.
--   RLS, triggers de updated_at, seed e bucket de Storage ficam para a
--   sprint-001b (fundacao). Triggers de RECALCULO ficam para a sprint-002.
--
--   Migration ADITIVA e IDEMPOTENTE (CREATE TABLE IF NOT EXISTS /
--   CREATE INDEX IF NOT EXISTS). NAO altera NENHUMA tabela viva
--   (avisos, aviso_chunks, memoria_chunks, execucoes, nomus_processos, ...).
--   Ordem de criacao respeita as dependencias de FK.
--
--   As "FK logicas" (escopo_id em parametros_calculo, parametro_regional,
--   cotacao_diretrizes, cotacao_regras, politica_participacao) NAO recebem
--   FK fisica: escopo_id aponta para produto_linhas OU produtos conforme o
--   nivel (acoplamento logico resolvido no motor/borda), seguindo a SPEC.
-- =====================================================================

-- ---------------------------------------------------------------------
-- produto_linhas (RF-01, US-01)
-- Segmento de produto (ex.: Limpeza, Ergonomia). Ancora parametros e
-- criterios no nivel Linha. nome UNIQUE = chave natural.
-- ---------------------------------------------------------------------
create table if not exists public.produto_linhas (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  descricao   text,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint produto_linhas_nome_key unique (nome)
);

-- ---------------------------------------------------------------------
-- produto_linha_atributos (RF-02, US-01, US-02)
-- Define o CONJUNTO de chaves de atributo validas por Linha.
-- ---------------------------------------------------------------------
create table if not exists public.produto_linha_atributos (
  id           uuid primary key default gen_random_uuid(),
  linha_id     uuid not null references public.produto_linhas(id) on delete restrict,
  chave        text not null,
  tipo         text not null default 'texto'
    check (tipo in ('texto', 'numero', 'booleano')),
  obrigatorio  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint produto_linha_atributos_linha_chave_key unique (linha_id, chave)
);

create index if not exists idx_produto_linha_atributos_linha
  on public.produto_linha_atributos (linha_id);

-- ---------------------------------------------------------------------
-- produtos (RF-02, RF-04, US-02)
-- Produto/Familia vinculado a uma Linha. Atributos flexiveis JSONB
-- validados na borda contra produto_linha_atributos.
-- ---------------------------------------------------------------------
create table if not exists public.produtos (
  id               uuid primary key default gen_random_uuid(),
  linha_id         uuid not null references public.produto_linhas(id) on delete restrict,
  nome             text not null,
  atributos        jsonb not null default '{}'::jsonb,
  prazo_entrega    text,
  disponibilidade  text,
  pedido_minimo    text,
  ativo            boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_produtos_linha
  on public.produtos (linha_id);

-- ---------------------------------------------------------------------
-- produto_skus (RF-03, RF-05, RF-11A, US-03, US-04, US-08)
-- Variante/SKU de um Produto. FABRICADO (BOM + mao de obra) ou COMPRADO
-- (custo de aquisicao). codigo_sku UNIQUE = chave natural.
-- ---------------------------------------------------------------------
create table if not exists public.produto_skus (
  id                 uuid primary key default gen_random_uuid(),
  produto_id         uuid not null references public.produtos(id) on delete restrict,
  codigo_sku         text not null,
  tipo_origem        text not null default 'fabricado'
    check (tipo_origem in ('fabricado', 'comprado')),
  dimensoes          jsonb,
  tolerancia_pct     numeric,
  acabamento         text,
  peso_gr            numeric,
  diretriz_producao  text,
  tempo_producao     numeric,
  estado_calculo     text not null default 'pendente'
    check (estado_calculo in ('vigente', 'pendente', 'erro')),
  ativo              boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint produto_skus_codigo_sku_key unique (codigo_sku)
);

create index if not exists idx_produto_skus_produto
  on public.produto_skus (produto_id);

create index if not exists idx_produto_skus_estado_calculo
  on public.produto_skus (estado_calculo);

create index if not exists idx_produto_skus_tipo_origem
  on public.produto_skus (tipo_origem);

-- ---------------------------------------------------------------------
-- produto_imagens (RF-05A, US-16, RNF-14)
-- Fotos de Produto e/ou SKU no Storage (bucket privado 'produtos').
-- CHECK: ao menos uma das FKs (produto_id ou sku_id) deve estar presente.
-- ---------------------------------------------------------------------
create table if not exists public.produto_imagens (
  id            uuid primary key default gen_random_uuid(),
  produto_id    uuid references public.produtos(id) on delete restrict,
  sku_id        uuid references public.produto_skus(id) on delete restrict,
  storage_path  text not null,
  ordem         integer not null default 0,
  legenda       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint produto_imagens_alvo_check
    check (produto_id is not null or sku_id is not null)
);

create index if not exists idx_produto_imagens_produto
  on public.produto_imagens (produto_id);

create index if not exists idx_produto_imagens_sku
  on public.produto_imagens (sku_id);

-- ---------------------------------------------------------------------
-- insumos (RF-06, US-05)
-- Insumos e materia-prima usados como entrada do calculo.
-- ---------------------------------------------------------------------
create table if not exists public.insumos (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  categoria   text not null
    check (categoria in ('MP', 'embalagem', 'insumo')),
  unidade     text not null,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- insumo_precos (RF-07, US-06)
-- Precos de fornecedor por insumo com vigencia; historico preservado.
-- ---------------------------------------------------------------------
create table if not exists public.insumo_precos (
  id               uuid primary key default gen_random_uuid(),
  insumo_id        uuid not null references public.insumos(id) on delete restrict,
  fornecedor       text,
  preco            numeric not null,
  vigencia_inicio  date not null default now(),
  vigencia_fim     date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_insumo_precos_insumo_vigencia
  on public.insumo_precos (insumo_id, vigencia_inicio);

-- ---------------------------------------------------------------------
-- sku_composicao (RF-08, US-04, US-08)
-- BOM estruturada: composicao de insumos por SKU (so SKU fabricado).
-- ---------------------------------------------------------------------
create table if not exists public.sku_composicao (
  id          uuid primary key default gen_random_uuid(),
  sku_id      uuid not null references public.produto_skus(id) on delete restrict,
  insumo_id   uuid not null references public.insumos(id) on delete restrict,
  quantidade  numeric not null,
  unidade     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint sku_composicao_sku_insumo_key unique (sku_id, insumo_id)
);

create index if not exists idx_sku_composicao_sku
  on public.sku_composicao (sku_id);

create index if not exists idx_sku_composicao_insumo
  on public.sku_composicao (insumo_id);

-- ---------------------------------------------------------------------
-- sku_custo_aquisicao (US-03, US-08)
-- Custo de aquisicao por SKU 'comprado', com historico de vigencia.
-- ---------------------------------------------------------------------
create table if not exists public.sku_custo_aquisicao (
  id               uuid primary key default gen_random_uuid(),
  sku_id           uuid not null references public.produto_skus(id) on delete restrict,
  fornecedor       text,
  custo            numeric not null,
  vigencia_inicio  date not null default now(),
  vigencia_fim     date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_sku_custo_aquisicao_sku_vigencia
  on public.sku_custo_aquisicao (sku_id, vigencia_inicio);

-- ---------------------------------------------------------------------
-- parametros_calculo (RF-09, RF-10, RF-11A, US-07, US-08)
-- Parametros escalares com heranca em 3 niveis (global/linha/produto).
-- escopo_id e FK LOGICA (sem FK fisica): null no global, linha/produto id
-- nos demais. Resolucao PRODUTO -> LINHA -> GLOBAL via COALESCE no motor.
-- ---------------------------------------------------------------------
create table if not exists public.parametros_calculo (
  id            uuid primary key default gen_random_uuid(),
  nivel         text not null
    check (nivel in ('global', 'linha', 'produto')),
  escopo_id     uuid,
  impostos_pct  numeric,
  frete_pct     numeric,
  despesas_pct  numeric,
  lucro_pct     numeric,
  taxa_horaria  numeric,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint parametros_calculo_nivel_escopo_key unique (nivel, escopo_id),
  constraint parametros_calculo_escopo_coerente_check
    check (
      (nivel = 'global' and escopo_id is null)
      or (nivel <> 'global' and escopo_id is not null)
    )
);

create index if not exists idx_parametros_calculo_nivel_escopo
  on public.parametros_calculo (nivel, escopo_id);

-- ---------------------------------------------------------------------
-- parametro_regional (RF-09, RF-10, US-07)
-- Vetor regional (uma linha por regiao), permite override parcial.
-- escopo_id e FK LOGICA (sem FK fisica). Resolucao por regiao.
-- ---------------------------------------------------------------------
create table if not exists public.parametro_regional (
  id          uuid primary key default gen_random_uuid(),
  nivel       text not null
    check (nivel in ('global', 'linha', 'produto')),
  escopo_id   uuid,
  regiao      text not null
    check (regiao in ('S', 'SE', 'CO', 'NE', 'N')),
  percentual  numeric not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint parametro_regional_nivel_escopo_regiao_key unique (nivel, escopo_id, regiao)
);

create index if not exists idx_parametro_regional_nivel_escopo_regiao
  on public.parametro_regional (nivel, escopo_id, regiao);

-- ---------------------------------------------------------------------
-- sku_precos_calculados (RF-12, RF-14, RF-15, US-08, US-09)
-- Preco calculado materializado por SKU/regiao/patamar (10 linhas/SKU).
-- valor e SEMPRE calculado pelo motor (nunca digitado).
-- ---------------------------------------------------------------------
create table if not exists public.sku_precos_calculados (
  id                  uuid primary key default gen_random_uuid(),
  sku_id              uuid not null references public.produto_skus(id) on delete restrict,
  regiao              text not null
    check (regiao in ('S', 'SE', 'CO', 'NE', 'N')),
  patamar             text not null
    check (patamar in ('CIF', 'FOB')),
  valor               numeric,
  custo_base          numeric,
  estado              text not null default 'pendente'
    check (estado in ('vigente', 'pendente', 'erro')),
  ifp                 numeric,
  preco_concorrencia  numeric,
  custo_ideal         numeric,
  calculado_em        timestamptz,
  valor_anterior      numeric,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint sku_precos_calculados_sku_regiao_patamar_key unique (sku_id, regiao, patamar)
);

create index if not exists idx_sku_precos_calculados_estado
  on public.sku_precos_calculados (estado);

-- ---------------------------------------------------------------------
-- clientes_revenda (RF-16, US-10)
-- Clientes do canal de revenda (ex.: DAGEAL, Novo Horizonte).
-- ---------------------------------------------------------------------
create table if not exists public.clientes_revenda (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- revenda_precos (RF-16, RF-17, US-10)
-- Preco de revenda por cliente/SKU, com historico (canal SEPARADO de
-- licitacao). Sem UNIQUE rigido: varios registros por par ao longo do tempo.
-- ---------------------------------------------------------------------
create table if not exists public.revenda_precos (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references public.clientes_revenda(id) on delete restrict,
  sku_id           uuid not null references public.produto_skus(id) on delete restrict,
  preco            numeric not null,
  vigencia_inicio  date not null default now(),
  vigencia_fim     date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_revenda_precos_cliente_sku_vigencia
  on public.revenda_precos (cliente_id, sku_id, vigencia_inicio);

-- ---------------------------------------------------------------------
-- cotacao_diretrizes (RF-18, US-11)
-- Diretriz textual de cotacao por LINHA ou PRODUTO (indexavel - RF-24).
-- escopo_id e FK LOGICA (sem FK fisica).
-- ---------------------------------------------------------------------
create table if not exists public.cotacao_diretrizes (
  id          uuid primary key default gen_random_uuid(),
  nivel       text not null
    check (nivel in ('linha', 'produto')),
  escopo_id   uuid not null,
  texto       text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_cotacao_diretrizes_nivel_escopo
  on public.cotacao_diretrizes (nivel, escopo_id);

-- ---------------------------------------------------------------------
-- cotacao_regras (RF-19, RF-20, RF-21, US-12)
-- Regras estruturadas por atributo. Precedencia PRODUTO sobre LINHA.
-- escopo_id e FK LOGICA (sem FK fisica).
-- ---------------------------------------------------------------------
create table if not exists public.cotacao_regras (
  id            uuid primary key default gen_random_uuid(),
  nivel         text not null
    check (nivel in ('linha', 'produto')),
  escopo_id     uuid not null,
  atributo      text not null,
  tipo_regra    text not null
    check (tipo_regra in ('faixa', 'opcional', 'substituicao')),
  valor_min     numeric,
  valor_max     numeric,
  substituicao  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint cotacao_regras_faixa_check
    check (valor_min is null or valor_max is null or valor_min <= valor_max)
);

create index if not exists idx_cotacao_regras_nivel_escopo_atributo
  on public.cotacao_regras (nivel, escopo_id, atributo);

-- ---------------------------------------------------------------------
-- politica_participacao (RF-21A, RF-21B, US-24) [MVP]
-- Politica de participacao por LINHA ou PRODUTO. Precedencia PRODUTO
-- sobre LINHA. escopo_id e FK LOGICA (sem FK fisica).
-- ---------------------------------------------------------------------
create table if not exists public.politica_participacao (
  id              uuid primary key default gen_random_uuid(),
  nivel           text not null
    check (nivel in ('linha', 'produto')),
  escopo_id       uuid not null,
  participa       text not null
    check (participa in ('sim', 'nao', 'condicional')),
  condicao        text,
  diretriz_texto  text,
  preferencia     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_politica_participacao_nivel_escopo
  on public.politica_participacao (nivel, escopo_id);
