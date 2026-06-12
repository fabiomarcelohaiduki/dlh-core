-- =====================================================================
-- Sprint: Backend - Imagens (Storage) e Revenda
-- Bucket privado 'produtos' para fotos de Produto/SKU (RNF-14, Decisao
-- Security 4 da SPEC).
--
-- As fotos de Produto/SKU sao PRESERVADAS num bucket PRIVADO (public=false).
-- Leitura via signed URL temporaria (TTL 1h, gerada server-side); escrita via
-- service_role (que BYPASSA a RLS do Storage). Defense in depth, alinhado a
-- RLS do substrato: apenas contas autorizadas (public.is_conta_autorizada())
-- acessam objetos pelo caminho do usuario. Espelha EXATAMENTE o padrao ja
-- usado pelo bucket 'editais'.
--
-- Migration ADITIVA e IDEMPOTENTE (on conflict do nothing / if not exists).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Bucket privado 'produtos' (public = false). Idempotente.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('produtos', 'produtos', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Policies de acesso aos objetos do bucket 'produtos' em storage.objects.
-- Leitura/gestao restritas a contas autorizadas (mesma policy do MVP).
-- service_role nao e afetado (bypassa RLS) — usado pela Edge Function.
-- ---------------------------------------------------------------------
do $$
begin
  -- SELECT (leitura/download por usuario autorizado).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'produtos_select_autorizado'
  ) then
    create policy produtos_select_autorizado on storage.objects
      for select
      using (bucket_id = 'produtos' and public.is_conta_autorizada());
  end if;

  -- INSERT (gravacao por usuario autorizado; Edge Function usa service_role).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'produtos_insert_autorizado'
  ) then
    create policy produtos_insert_autorizado on storage.objects
      for insert
      with check (bucket_id = 'produtos' and public.is_conta_autorizada());
  end if;

  -- UPDATE (sobrescrita/upsert por usuario autorizado).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'produtos_update_autorizado'
  ) then
    create policy produtos_update_autorizado on storage.objects
      for update
      using (bucket_id = 'produtos' and public.is_conta_autorizada())
      with check (bucket_id = 'produtos' and public.is_conta_autorizada());
  end if;

  -- DELETE (limpeza por usuario autorizado).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'produtos_delete_autorizado'
  ) then
    create policy produtos_delete_autorizado on storage.objects
      for delete
      using (bucket_id = 'produtos' and public.is_conta_autorizada());
  end if;
end;
$$;
