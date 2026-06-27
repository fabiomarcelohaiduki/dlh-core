-- =====================================================================
-- Fase 0 — Cockpit LionClaw (SPEC secao 2.1.2/2.1.3 + 2.2.1)
-- Migration 1/4: base de organizacao (org / org_membership)
--
-- RECONCILIACAO COM A REALIDADE DO REPO (dica do sprint):
--   A SPEC trata `org` e `org_membership` como tabelas JA EXISTENTES no
--   DLH-Core (D-DB-02) e manda "reusar, NAO recriar". Porem o esquema real
--   deste repositorio NAO possui essas tabelas: o controle de acesso atual
--   e feito por `contas_autorizadas` + `is_conta_autorizada()` (allowlist),
--   sem o conceito de organizacao.
--
--   Como as tabelas tema/configuracao/bloco_config da Fase 0 declaram FK
--   `org_id -> org` e as policies de isolamento dependem de `org_membership`,
--   esta migration cria uma base MINIMA dessas duas tabelas guardada por
--   `create table if not exists`. Em ambientes onde elas ja existirem, os
--   comandos sao NO-OP (nada e recriado/alterado) — honrando "nao recriar".
--   Onde nao existirem (este repo), passam a existir para que as FKs e a
--   RLS da Fase 0 sejam validas e a migration aplique de forma limpa.
--
--   Schema minimo conforme SPEC:
--     org           = id (PK), nome (+ created_at de apoio)
--     org_membership= user_id, org_id, papel  (PK composta)
-- =====================================================================

-- ---------------------------------------------------------------------
-- org: estrutura de organizacao (SPEC 2.1.2). Reuso se ja existir.
-- ---------------------------------------------------------------------
create table if not exists public.org (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- org_membership: vinculo usuario <-> organizacao (SPEC 2.1.3).
-- papel mantido como text livre (tabela de infra "reusada"); o valor
-- 'manutencao' habilita a escrita no catalogo de temas (SPEC 2.2.2).
-- ---------------------------------------------------------------------
create table if not exists public.org_membership (
  user_id     uuid not null references auth.users (id) on delete cascade,
  org_id      uuid not null references public.org (id) on delete cascade,
  papel       text not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (user_id, org_id)
);

create index if not exists idx_org_membership_user on public.org_membership (user_id);
create index if not exists idx_org_membership_org  on public.org_membership (org_id);

-- ---------------------------------------------------------------------
-- Helpers SECURITY DEFINER para as policies da Fase 0.
-- Rodam com o dono da funcao para evitar dependencia da RLS/visibilidade
-- de org_membership dentro das policies (mesmo padrao de is_conta_autorizada).
-- ---------------------------------------------------------------------

-- Conjunto de org_ids aos quais o usuario autenticado pertence.
create or replace function public.current_user_orgs()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.org_id
  from public.org_membership m
  where m.user_id = auth.uid();
$$;

comment on function public.current_user_orgs() is
  'Fase 0: org_ids do usuario autenticado (auth.uid()), via org_membership. SECURITY DEFINER evita recursao/visibilidade de RLS nas policies.';

-- True quando o usuario autenticado tem papel 'manutencao' em alguma org.
create or replace function public.has_papel_manutencao()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.org_membership m
    where m.user_id = auth.uid()
      and m.papel = 'manutencao'
  );
$$;

comment on function public.has_papel_manutencao() is
  'Fase 0: true quando o usuario autenticado possui papel manutencao em alguma org (gate de escrita do catalogo de temas - SPEC 2.2.2).';
