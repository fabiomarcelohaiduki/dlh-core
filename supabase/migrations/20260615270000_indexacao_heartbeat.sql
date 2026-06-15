-- =====================================================================
-- Migration: HEARTBEAT da indexacao (cron de seguranca 10min -> 1min).
--
-- PROBLEMA (diagnostico 2026-06-15): com o lock single-flight (migration
-- 260000), a cadeia pg_net deixou de se auto-perpetuar de forma confiavel:
--   (a) a continuacao era disparada com o lock AINDA na mao -> a proxima
--       invocacao caia em "ocupado" e morria sem reagendar (corrigido no
--       Edge: o reenfileirar agora sai DEPOIS do unlock);
--   (b) quando uma invocacao morre por wall-clock, o finally nao roda ->
--       nao solta o lock NEM dispara a cadeia. So um marca-passo externo
--       religa o backfill.
-- Com o cron a cada 10 min, cada morte da cadeia custava ate 10 min de fila
-- congelada. Empirico: ~3 docs indexados em 13 min (fila praticamente parada).
--
-- FIX: encurtar o marca-passo para 1 minuto. O lock single-flight torna a
-- sobreposicao segura (tique que pega o lock ocupado vira no-op barato), entao
-- aumentar a frequencia nao reintroduz o storm de 429 -- so reduz a janela de
-- recuperacao apos uma morte de cadeia de <=10min para <=1min. O guard de
-- master switch + has-pending mantem o custo zero com a fila vazia ou switch
-- OFF. cron.schedule substitui o job de mesmo nome (idempotente).
--
-- Aplicar via Node `pg` (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

select cron.schedule(
  'indexacao-kick',
  '* * * * *',
  $cron$
    select public.reenfileirar_indexacao()
    where coalesce((select ativo from public.config_indexacao limit 1), false)
      and public.tem_documento_pendente_indexacao(null);
  $cron$
);
