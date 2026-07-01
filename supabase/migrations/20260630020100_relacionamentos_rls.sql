-- =====================================================================
-- Feature: Relacionamentos (Documento feature-relacionamentos.md / SPEC secao 2.2)
-- Migration 2/3: Row Level Security (RLS) das 5 tabelas criadas na
-- migration 1/3 (relacionamentos_tabelas.sql).
--
-- Modelo de isolamento:
--   relacoes                 -> GLOBAL; SELECT via allowlist (is_conta_autorizada()).
--                              service_role e o unico writer (backfill + Triagem).
--                              SEM policies de INSERT/UPDATE/DELETE.
--   catalogo_regras_vinculo  -> POR ORG; SELECT com fallback allowlist;
--                              INSERT/UPDATE/DELETE exigem membership.
--   vinculos_inferidos_lia   -> mesmo padrao.
--   config_relacionamentos   -> mesmo padrao.
--   config_tipos_no          -> mesmo padrao.
--
-- Helpers SECURITY DEFINER (current_user_orgs, is_conta_autorizada)
-- vem das migrations existentes (fase0_org_membership.sql e rls.sql).
-- Defense in depth: policies rodam tambem em chamadas via service_role
-- a partir de contextos anonimos (mas BYPASSRLS no service_role ignora).
--
-- Tudo idempotente: drop policy if exists antes de criar.
-- =====================================================================

-- =====================================================================
-- 2.2.1 relacoes (GLOBAL) - SELECT via allowlist; escrita so service_role.
-- =====================================================================
alter table public.relacoes enable row level security;

drop policy if exists relacoes_select_allowlist on public.relacoes;
create policy relacoes_select_allowlist on public.relacoes
  for select
  to authenticated
  using (public.is_conta_autorizada());

-- INSERT/UPDATE/DELETE: nenhuma policy. service_role escreve via BYPASSRLS;
-- qualquer outro papel e bloqueado por deny-by-default.

-- =====================================================================
-- 2.2.2 catalogo_regras_vinculo (POR ORG)
-- =====================================================================
alter table public.catalogo_regras_vinculo enable row level security;

drop policy if exists catalogo_regras_vinculo_select_org on public.catalogo_regras_vinculo;
create policy catalogo_regras_vinculo_select_org on public.catalogo_regras_vinculo
  for select
  to authenticated
  using (
    (org_id in (select public.current_user_orgs()))
    or public.is_conta_autorizada()
  );

drop policy if exists catalogo_regras_vinculo_insert_org on public.catalogo_regras_vinculo;
create policy catalogo_regras_vinculo_insert_org on public.catalogo_regras_vinculo
  for insert
  to authenticated
  with check (
    org_id in (select public.current_user_orgs())
  );

drop policy if exists catalogo_regras_vinculo_update_org on public.catalogo_regras_vinculo;
create policy catalogo_regras_vinculo_update_org on public.catalogo_regras_vinculo
  for update
  to authenticated
  using (
    org_id in (select public.current_user_orgs())
  )
  with check (
    org_id in (select public.current_user_orgs())
  );

drop policy if exists catalogo_regras_vinculo_delete_org on public.catalogo_regras_vinculo;
create policy catalogo_regras_vinculo_delete_org on public.catalogo_regras_vinculo
  for delete
  to authenticated
  using (
    org_id in (select public.current_user_orgs())
  );

-- =====================================================================
-- 2.2.3 vinculos_inferidos_lia (POR ORG)
-- =====================================================================
alter table public.vinculos_inferidos_lia enable row level security;

drop policy if exists vinculos_inferidos_lia_select_org on public.vinculos_inferidos_lia;
create policy vinculos_inferidos_lia_select_org on public.vinculos_inferidos_lia
  for select
  to authenticated
  using (
    (org_id in (select public.current_user_orgs()))
    or public.is_conta_autorizada()
  );

drop policy if exists vinculos_inferidos_lia_insert_org on public.vinculos_inferidos_lia;
create policy vinculos_inferidos_lia_insert_org on public.vinculos_inferidos_lia
  for insert
  to authenticated
  with check (
    org_id in (select public.current_user_orgs())
  );

drop policy if exists vinculos_inferidos_lia_update_org on public.vinculos_inferidos_lia;
create policy vinculos_inferidos_lia_update_org on public.vinculos_inferidos_lia
  for update
  to authenticated
  using (
    org_id in (select public.current_user_orgs())
  )
  with check (
    org_id in (select public.current_user_orgs())
  );

drop policy if exists vinculos_inferidos_lia_delete_org on public.vinculos_inferidos_lia;
create policy vinculos_inferidos_lia_delete_org on public.vinculos_inferidos_lia
  for delete
  to authenticated
  using (
    org_id in (select public.current_user_orgs())
  );

-- =====================================================================
-- 2.2.4 config_relacionamentos (POR ORG)
-- =====================================================================
alter table public.config_relacionamentos enable row level security;

drop policy if exists config_relacionamentos_select_org on public.config_relacionamentos;
create policy config_relacionamentos_select_org on public.config_relacionamentos
  for select
  to authenticated
  using (
    (org_id in (select public.current_user_orgs()))
    or public.is_conta_autorizada()
  );

drop policy if exists config_relacionamentos_insert_org on public.config_relacionamentos;
create policy config_relacionamentos_insert_org on public.config_relacionamentos
  for insert
  to authenticated
  with check (
    org_id in (select public.current_user_orgs())
  );

drop policy if exists config_relacionamentos_update_org on public.config_relacionamentos;
create policy config_relacionamentos_update_org on public.config_relacionamentos
  for update
  to authenticated
  using (
    org_id in (select public.current_user_orgs())
  )
  with check (
    org_id in (select public.current_user_orgs())
  );

drop policy if exists config_relacionamentos_delete_org on public.config_relacionamentos;
create policy config_relacionamentos_delete_org on public.config_relacionamentos
  for delete
  to authenticated
  using (
    org_id in (select public.current_user_orgs())
  );

-- =====================================================================
-- 2.2.5 config_tipos_no (POR ORG)
-- =====================================================================
alter table public.config_tipos_no enable row level security;

drop policy if exists config_tipos_no_select_org on public.config_tipos_no;
create policy config_tipos_no_select_org on public.config_tipos_no
  for select
  to authenticated
  using (
    (org_id in (select public.current_user_orgs()))
    or public.is_conta_autorizada()
  );

drop policy if exists config_tipos_no_insert_org on public.config_tipos_no;
create policy config_tipos_no_insert_org on public.config_tipos_no
  for insert
  to authenticated
  with check (
    org_id in (select public.current_user_orgs())
  );

drop policy if exists config_tipos_no_update_org on public.config_tipos_no;
create policy config_tipos_no_update_org on public.config_tipos_no
  for update
  to authenticated
  using (
    org_id in (select public.current_user_orgs())
  )
  with check (
    org_id in (select public.current_user_orgs())
  );

drop policy if exists config_tipos_no_delete_org on public.config_tipos_no;
create policy config_tipos_no_delete_org on public.config_tipos_no
  for delete
  to authenticated
  using (
    org_id in (select public.current_user_orgs())
  );