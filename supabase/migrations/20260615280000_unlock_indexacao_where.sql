-- =====================================================================
-- Migration: FIX unlock_indexacao bloqueado pelo pg-safeupdate.
--
-- PROBLEMA (diagnostico 2026-06-15, log da Edge documentos-indexar):
--   "[documentos-indexar] unlock_indexacao falhou UPDATE requires a WHERE clause"
-- A funcao unlock_indexacao (migration 20260615260000) faz
--   update config_indexacao set lock_ts = null;
-- SEM clausula WHERE. O guard pg-safeupdate do Supabase rejeita
-- UPDATE/DELETE sem WHERE -> o unlock SEMPRE falha -> o lock de fluxo
-- unico nunca e liberado pela invocacao; so expira por idade (stale 3min)
-- ou pelo cron indexacao-kick (10min). O auto-encadeamento via pg_net
-- encontra o lock ainda preso e retorna "ocupado" -> a cadeia morre ->
-- backfill anda ~1 lote a cada 3-10min em vez de encadear continuo.
--
-- FIX: adicionar WHERE real ao UPDATE. `where lock_ts is not null` satisfaz
-- o guard e e semanticamente correto (no-op idempotente quando ja livre).
--
-- Idempotente (create or replace). Aplicar via Node `pg` (SUPABASE_DB_URL).
-- =====================================================================

create or replace function public.unlock_indexacao()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.config_indexacao set lock_ts = null where lock_ts is not null;
end;
$$;

comment on function public.unlock_indexacao() is
  'Libera o lock de fluxo unico do backfill de indexacao (config_indexacao.lock_ts = null). Idempotente. WHERE lock_ts is not null evita o bloqueio do pg-safeupdate (UPDATE sem WHERE).';

revoke all on function public.unlock_indexacao() from public, anon, authenticated;
grant execute on function public.unlock_indexacao() to service_role;
