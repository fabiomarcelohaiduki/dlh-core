-- =====================================================================
-- Fase 0 — Cockpit LionClaw (SPEC secao 2.1.1, 2.1.4, 2.1.9)
-- Migration 2/4: tabelas da fundacao que NAO dependem de dado de negocio.
--   - tema           (2.1.1) catalogo global de temas visuais
--   - configuracao   (2.1.4) preferencias por usuario + organizacao
--   - bloco_config   (2.1.9) config reutilizavel por escopo hierarquico
--
-- DESCOPE EXPLICITO: execucao_coleta (2.1.7) e item_capturado (2.1.8) NAO
-- sao criadas aqui — serao reconciliadas no pipeline da Coleta.
--
-- Enums modelados como CHECK sobre text (padrao do repo). FKs apontam para
-- auth.users e para org/org_membership (base criada na migration 1/4).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 2.1.1 tema: catalogo dos temas visuais. Leitura global autenticada.
-- ---------------------------------------------------------------------
create table if not exists public.tema (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  acento      text not null,                 -- cor hex de marca (acento)
  fundo       text not null,                 -- cor hex de fundo
  texto       text not null,                 -- cor hex de texto
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2.1.4 configuracao: preferencias por usuario + organizacao.
-- Isolamento user_id + org_id (1 linha por usuario/org).
-- ---------------------------------------------------------------------
create table if not exists public.configuracao (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  org_id                uuid not null references public.org (id) on delete cascade,
  area_inicial          text
                          check (area_inicial in ('cockpit','atividade_global','configuracao_geral')),
  linhas_compactas      boolean not null default false,
  destacar_pendencias   boolean not null default true,
  tema_id               uuid references public.tema (id),  -- nullable: padrao = LionClaw
  densidade             text not null default 'confortavel'
                          check (densidade in ('compacta','padrao','confortavel')),
  reduzir_movimento     boolean not null default false,
  highlight_pendencias  boolean not null default true,
  default_area          text
                          check (default_area in ('cockpit','atividade_global','configuracao_geral')),
  tz                    text not null default 'America/Sao_Paulo',
  date_fmt              text not null default 'DD/MM/YYYY',
  num_fmt               text not null default 'pt-BR',
  notify_alerts         boolean not null default true,
  notify_ingest         boolean not null default true,
  notify_deadline       boolean not null default true,
  notify_digest         boolean not null default false,
  auto_sync             boolean not null default false,
  sync_freq             int not null default 15
                          check (sync_freq in (5,15,30,60)),
  session_timeout       int not null default 30
                          check (session_timeout in (0,15,30,60,240)),
  session_warn          boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, org_id)   -- preferencias = singleton por usuario/org (2.4.2)
);

create index if not exists idx_configuracao_user on public.configuracao (user_id);
create index if not exists idx_configuracao_org  on public.configuracao (org_id);

-- ---------------------------------------------------------------------
-- 2.1.9 bloco_config: configuracao reutilizavel por escopo hierarquico
-- (blocos por tela + cards do cockpit + paineis fixos). Isolamento
-- user_id + org_id. UNIQUE (user_id, org_id, escopo, tipo).
-- ---------------------------------------------------------------------
create table if not exists public.bloco_config (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  org_id      uuid not null references public.org (id) on delete cascade,
  escopo      text not null,                 -- path hierarquico (ex.: ingestao.coleta.agendamento.lote)
  tipo        text not null
                check (tipo in ('bloco','card','widget')),
  visivel     boolean not null default true,
  ordem       int not null default 0,
  banda       text
                check (banda in ('topo','status','ferramentas','acao','tabela')),  -- nullable
  valor       jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, org_id, escopo, tipo)
);

create index if not exists idx_bloco_config_user on public.bloco_config (user_id);
create index if not exists idx_bloco_config_org  on public.bloco_config (org_id);
create index if not exists idx_bloco_config_escopo on public.bloco_config (user_id, org_id, escopo);
