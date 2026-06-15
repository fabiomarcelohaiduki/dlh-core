-- =====================================================================
-- Migration: TRAVA DE FLUXO UNICO (single-flight) da indexacao.
--
-- PROBLEMA (diagnostico 2026-06-15): o backfill nao tem protecao contra
-- MULTIPLAS invocacoes simultaneas. O auto-encadeamento (reenfileirar_
-- indexacao via pg_net) + o cron indexacao-kick + disparos manuais podem
-- gerar varias CADEIAS PARALELAS. Cada invocacao chama a OpenAI -> N
-- invocacoes concorrentes = burst somado que estoura o rate limit (429
-- sustentado), esgotando o retry e derrubando ate 90% dos documentos.
-- Medido: 1 invocacao isolada sob storm = 10 processados, 1 indexado, 9
-- erros.
--
-- SOLUCAO: lock determinIstico de fluxo unico no singleton config_indexacao
-- (governanca SOM: regra critica e DETERMINISTICA no banco, nao na IA). So
-- UMA invocacao processa por vez; as demais retornam "ocupado" de imediato.
-- Stale-aware: se uma invocacao morrer sem liberar (wall-clock mata o
-- isolate antes do finally), o lock expira por idade e o cron/proxima
-- invocacao retoma -> nunca trava para sempre.
--
--   try_lock_indexacao(p_stale_minutes) -> true se adquiriu (atomico:
--     so seta lock_ts se estava livre OU vencido). false = ocupado.
--   unlock_indexacao() -> libera o lock (idempotente).
--
-- Idempotente. Aplicar via Node `pg` (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

alter table public.config_indexacao
  add column if not exists lock_ts timestamptz;

comment on column public.config_indexacao.lock_ts is
  'Lock de fluxo unico do backfill de indexacao: timestamp da invocacao que detem o processamento. NULL = livre. Stale-aware (try_lock_indexacao expira locks vencidos) -> nunca trava permanentemente se uma invocacao morrer sem liberar.';

-- ---------------------------------------------------------------------
-- Adquire o lock atomicamente. Retorna true se conseguiu (estava livre ou
-- vencido), false se outra invocacao detem o lock e ainda esta viva.
-- ---------------------------------------------------------------------
create or replace function public.try_lock_indexacao(
  p_stale_minutes int default 3
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update public.config_indexacao
    set lock_ts = now()
    where lock_ts is null
       or lock_ts < now() - make_interval(mins => greatest(1, p_stale_minutes))
    returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

comment on function public.try_lock_indexacao(int) is
  'Adquire atomicamente o lock de fluxo unico do backfill de indexacao no singleton config_indexacao. Retorna true se adquiriu (lock livre ou vencido alem de p_stale_minutes); false se outra invocacao o detem. Garante uma unica invocacao processando por vez (evita storm de 429 na OpenAI).';

revoke all on function public.try_lock_indexacao(int) from public, anon, authenticated;
grant execute on function public.try_lock_indexacao(int) to service_role;

-- ---------------------------------------------------------------------
-- Libera o lock (idempotente). Chamado no fim/finally da invocacao.
-- ---------------------------------------------------------------------
create or replace function public.unlock_indexacao()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.config_indexacao set lock_ts = null;
end;
$$;

comment on function public.unlock_indexacao() is
  'Libera o lock de fluxo unico do backfill de indexacao (config_indexacao.lock_ts = null). Idempotente.';

revoke all on function public.unlock_indexacao() from public, anon, authenticated;
grant execute on function public.unlock_indexacao() to service_role;
