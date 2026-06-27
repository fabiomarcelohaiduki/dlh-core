-- =====================================================================
-- Fase 0 — Cockpit LionClaw (SPEC secao 2.2 e 2.3.1)
-- Migration 3/4: RLS das tabelas da Fase 0 + trigger set_updated_at.
--
-- Modelo de isolamento (multi-tenant leve por organizacao):
--   tema         -> leitura para todo autenticado; escrita so papel manutencao
--   configuracao -> linhas do proprio usuario (user_id = auth.uid()) na sua org
--   bloco_config -> idem configuracao
-- Helpers SECURITY DEFINER (current_user_orgs / has_papel_manutencao) vem da
-- migration 1/4. set_updated_at criada aqui conforme exigido na SPEC 2.3.1.
-- =====================================================================

-- =====================================================================
-- 2.3.1 Funcao set_updated_at (nome exigido pela SPEC).
-- =====================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Fase 0 (SPEC 2.3.1): seta updated_at = now() em BEFORE UPDATE.';

-- =====================================================================
-- RLS: tema
--   select_authenticated -> qualquer usuario autenticado le.
--   modify_maintenance   -> escrita restrita a papel manutencao.
-- =====================================================================
alter table public.tema enable row level security;

drop policy if exists tema_select_authenticated on public.tema;
create policy tema_select_authenticated on public.tema
  for select
  to authenticated
  using (true);

drop policy if exists tema_modify_maintenance on public.tema;
create policy tema_modify_maintenance on public.tema
  for all
  to authenticated
  using (public.has_papel_manutencao())
  with check (public.has_papel_manutencao());

-- =====================================================================
-- RLS: configuracao
--   SELECT -> user_id = auth.uid() AND org_id na membership do usuario.
--   modify (INSERT/UPDATE/DELETE) -> user_id = auth.uid()
--            (WITH CHECK tambem amarra org_id a membership do usuario).
-- =====================================================================
alter table public.configuracao enable row level security;

drop policy if exists configuracao_select_own_user_org on public.configuracao;
create policy configuracao_select_own_user_org on public.configuracao
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and org_id in (select public.current_user_orgs())
  );

drop policy if exists configuracao_insert_own_user on public.configuracao;
create policy configuracao_insert_own_user on public.configuracao
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and org_id in (select public.current_user_orgs())
  );

drop policy if exists configuracao_update_own_user on public.configuracao;
create policy configuracao_update_own_user on public.configuracao
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and org_id in (select public.current_user_orgs())
  );

drop policy if exists configuracao_delete_own_user on public.configuracao;
create policy configuracao_delete_own_user on public.configuracao
  for delete
  to authenticated
  using (user_id = auth.uid());

-- =====================================================================
-- RLS: bloco_config (mesma logica de configuracao).
-- =====================================================================
alter table public.bloco_config enable row level security;

drop policy if exists bloco_config_select_own_user_org on public.bloco_config;
create policy bloco_config_select_own_user_org on public.bloco_config
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and org_id in (select public.current_user_orgs())
  );

drop policy if exists bloco_config_insert_own_user on public.bloco_config;
create policy bloco_config_insert_own_user on public.bloco_config
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and org_id in (select public.current_user_orgs())
  );

drop policy if exists bloco_config_update_own_user on public.bloco_config;
create policy bloco_config_update_own_user on public.bloco_config
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and org_id in (select public.current_user_orgs())
  );

drop policy if exists bloco_config_delete_own_user on public.bloco_config;
create policy bloco_config_delete_own_user on public.bloco_config
  for delete
  to authenticated
  using (user_id = auth.uid());

-- =====================================================================
-- 2.3.1 Triggers BEFORE UPDATE: configuracao e bloco_config.
-- (tema nao tem updated_at -> sem trigger).
-- =====================================================================
drop trigger if exists trg_set_updated_at_configuracao on public.configuracao;
create trigger trg_set_updated_at_configuracao
  before update on public.configuracao
  for each row execute function public.set_updated_at();

drop trigger if exists trg_set_updated_at_bloco_config on public.bloco_config;
create trigger trg_set_updated_at_bloco_config
  before update on public.bloco_config
  for each row execute function public.set_updated_at();
