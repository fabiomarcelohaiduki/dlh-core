-- =====================================================================
-- Feature: Relacionamentos (Documento feature-relacionamentos.md / SPEC secao 2.1)
-- Migration 1/3: schema das 5 tabelas da feature Relacionamentos.
--
-- Escopo: SOMENTE estrutura - colunas, tipos, defaults, FKs, CHECKs,
-- UNIQUE constraints e indexes. RLS fica para a migration 2/3
-- (relacionamentos_rls.sql). Triggers de versao e o trigger anti
-- numero_pregao ficam para a migration 3/3 (relacionamentos_triggers.sql).
--
-- Padrao: migration ADITIVA e IDEMPOTENTE (CREATE TABLE IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS).
-- NAO altera NENHUMA tabela viva (avisos, nomus_processos,
-- catalogo_regras_vinculo, etc).
--
-- Decisoes arquiteturais importantes:
--   * relacoes e GLOBAL (sem org_id) - verdade de schema compartilhada.
--   * origem_id/destino_id sao TEXT (nao UUID) - suporta CNPJ e outros
--     identificadores nao-UUID.
--   * NUNCA usar o apelido "graphrag" - usar "relacionamentos" /
--     "relacoes" / "catalogo_regras_vinculo" / etc.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 2.1.1 relacoes (GLOBAL, sem org_id)
-- Arestas estruturais e de match entre nos polimorficos (tipo, id).
-- unique (origem_tipo, origem_id, destino_tipo, destino_id, relacao) e
-- a base da idempotencia do backfill (RF-12, RNF-05).
-- ---------------------------------------------------------------------
create table if not exists public.relacoes (
  id            uuid primary key default gen_random_uuid(),
  origem_tipo   text not null,
  origem_id     text not null,
  destino_tipo  text not null,
  destino_id    text not null,
  relacao       text not null,
  metodo        text not null
                  check (metodo in ('deterministico','sugerido')),
  chave         text not null,
  confianca     numeric not null default 1.0,
  status        text not null default 'confirmado'
                  check (status in ('confirmado','sugerido','rejeitado')),
  versao        int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (origem_tipo, origem_id, destino_tipo, destino_id, relacao)
);

comment on table public.relacoes is
  'Relacionamentos: arestas estruturais e de match entre nos polimorficos (tipo, id). GLOBAL (sem org_id) por decisao arquitetural.';

create index if not exists idx_relacoes_origem
  on public.relacoes (origem_tipo, origem_id);
create index if not exists idx_relacoes_destino
  on public.relacoes (destino_tipo, destino_id);
create index if not exists idx_relacoes_status
  on public.relacoes (status)
  where status = 'confirmado';
create index if not exists idx_relacoes_relacao
  on public.relacoes (relacao);

-- ---------------------------------------------------------------------
-- 2.1.2 catalogo_regras_vinculo (POR ORG)
-- Catalogo oficial de regras macro definidas por humano para casar nos
-- por campo. combinacao em ('simples','composta'). O trigger anti
-- numero_pregao sozinho (criado na migration 3/3) protege backfill e
-- inserts diretos via service_role.
-- ---------------------------------------------------------------------
create table if not exists public.catalogo_regras_vinculo (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.org (id) on delete cascade,
  nome          text,
  origem_tipo   text not null,
  campo_origem  text not null,
  destino_tipo  text not null,
  campo_destino text not null,
  combinacao    text not null
                  check (combinacao in ('simples','composta')),
  sequencia     text[],
  ativa         boolean not null default false,
  versao        int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.catalogo_regras_vinculo is
  'Relacionamentos: catalogo oficial de regras macro (campo-a-campo) por org. Backfill so considera ativa=true.';

create index if not exists idx_catalogo_regras_org
  on public.catalogo_regras_vinculo (org_id);
create index if not exists idx_catalogo_regras_ativa
  on public.catalogo_regras_vinculo (org_id)
  where ativa = true;

-- UNIQUE INDEX para idempotencia do seed (feat-002-01 via
-- ON CONFLICT DO NOTHING) e protecao contra duplicacao de regras
-- funcionais por org no backfill.
create unique index if not exists uq_catalogo_regras_funcional
  on public.catalogo_regras_vinculo (org_id, origem_tipo, campo_origem, destino_tipo, campo_destino);

-- ---------------------------------------------------------------------
-- 2.1.3 vinculos_inferidos_lia (POR ORG)
-- Memoria operacional da Lia: regras inferidas a partir de uso, ainda
-- nao promovidas a regras humanas oficiais. FK opcional regra_macro_id
-- com ON DELETE RESTRICT - impede exclusao de regra humana enquanto ha
-- vinculos inferidos apontando para ela (defesa em profundidade).
-- ---------------------------------------------------------------------
create table if not exists public.vinculos_inferidos_lia (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.org (id) on delete cascade,
  descricao          text not null,
  contador_uso       int not null default 0,
  contador_2caminhos int not null default 0,
  origem             text not null
                       check (origem in ('lia','humano')),
  motivo             text,
  regra_macro_id     uuid references public.catalogo_regras_vinculo (id) on delete restrict,
  status             text not null default 'proposta'
                       check (status in ('proposta','ativa','rejeitada')),
  versao             int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.vinculos_inferidos_lia is
  'Relacionamentos: memoria operacional da Lia (regras inferidas). FK opcional para catalogo_regras_vinculo ON DELETE RESTRICT.';

create index if not exists idx_vinculos_lia_org
  on public.vinculos_inferidos_lia (org_id);
create index if not exists idx_vinculos_lia_status
  on public.vinculos_inferidos_lia (org_id)
  where status = 'proposta';
create index if not exists idx_vinculos_lia_regra_macro
  on public.vinculos_inferidos_lia (regra_macro_id);

-- ---------------------------------------------------------------------
-- 2.1.4 config_relacionamentos (POR ORG, 1 LINHA POR ORG)
-- Thresholds e limites da feature, editaveis em UI sem deploy.
-- UNIQUE (org_id) garante singleton por org.
-- ---------------------------------------------------------------------
create table if not exists public.config_relacionamentos (
  id                               uuid primary key default gen_random_uuid(),
  org_id                           uuid not null references public.org (id) on delete cascade,
  uso_minimo_promocao_alternativa  int not null default 10,
  dois_caminhos_minimo             int not null default 5,
  uso_minimo_promocao              int not null default 5,
  cap_panorama                     int,
  cap_vizinhanca                   int not null default 5,
  profundidade_max_lia            int not null default 5,
  profundidade_default_panorama   int not null default 2,
  versao                           int not null default 0,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now(),
  unique (org_id)
);

comment on table public.config_relacionamentos is
  'Relacionamentos: thresholds e modos da feature por org (1 linha por org). Editaveis em UI sem deploy.';

-- ---------------------------------------------------------------------
-- 2.1.5 config_tipos_no (POR ORG, 1 LINHA POR TIPO POR ORG)
-- Cadastro visual (label, icone, cor, ordem) dos tipos de no por org.
-- UNIQUE (org_id, tipo) impede duplicacao de cadastro por tipo.
-- ---------------------------------------------------------------------
create table if not exists public.config_tipos_no (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.org (id) on delete cascade,
  tipo        text not null,
  label       text not null,
  icone       text not null,
  cor         text not null,
  ordem       int not null default 0,
  ativo       boolean not null default true,
  versao      int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, tipo)
);

comment on table public.config_tipos_no is
  'Relacionamentos: cadastro visual de tipos de no por org (label, icone, cor, ordem, ativo).';