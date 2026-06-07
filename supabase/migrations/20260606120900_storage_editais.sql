-- =====================================================================
-- Sprint: Backend - pipeline de ingestao (tratamento de arquivos)
-- Migration 10/xx: Bucket privado de Storage para binarios de edital
--
-- Objetivo (US-19/RF-33): os arquivos de edital baixados por link sao
-- PRESERVADOS num bucket PRIVADO do Supabase Storage (links Effecti podem
-- expirar; o binario garante recuperabilidade e reprocesso por item).
-- aviso_arquivos.storage_path referencia o objeto neste bucket.
--
-- Acesso (defense in depth, alinhado a RLS do substrato): apenas contas
-- autorizadas (public.is_conta_autorizada()) leem objetos do bucket. As
-- escritas do pipeline usam service_role, que BYPASSA a RLS do Storage.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Bucket privado 'editais' (public = false). Idempotente.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('editais', 'editais', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Policies de acesso aos objetos do bucket 'editais' em storage.objects.
-- Leitura/gestao restritas a contas autorizadas (mesma policy do MVP).
-- service_role nao e afetado (bypassa RLS) — usado pelo pipeline server-side.
-- ---------------------------------------------------------------------
do $$
begin
  -- SELECT (leitura/download por usuario autorizado).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'editais_select_autorizado'
  ) then
    create policy editais_select_autorizado on storage.objects
      for select
      using (bucket_id = 'editais' and public.is_conta_autorizada());
  end if;

  -- INSERT (gravacao por usuario autorizado; pipeline usa service_role).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'editais_insert_autorizado'
  ) then
    create policy editais_insert_autorizado on storage.objects
      for insert
      with check (bucket_id = 'editais' and public.is_conta_autorizada());
  end if;

  -- UPDATE (sobrescrita/upsert por usuario autorizado).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'editais_update_autorizado'
  ) then
    create policy editais_update_autorizado on storage.objects
      for update
      using (bucket_id = 'editais' and public.is_conta_autorizada())
      with check (bucket_id = 'editais' and public.is_conta_autorizada());
  end if;

  -- DELETE (limpeza por usuario autorizado).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'editais_delete_autorizado'
  ) then
    create policy editais_delete_autorizado on storage.objects
      for delete
      using (bucket_id = 'editais' and public.is_conta_autorizada());
  end if;
end;
$$;
