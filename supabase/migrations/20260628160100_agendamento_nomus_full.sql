-- =====================================================================
-- Migration: cron dedicado da RE-VARREDURA FULL de processos Nomus.
--
-- MOTIVO (28/06): complementa a coleta incremental diaria (19:00, so novos
-- por id) com uma re-varredura full periodica que re-coleta processos antigos
-- dentro do corte de idade (janela_dias) e atualiza mudancas de etapa.
--
-- CADENCIA: diaria 03:00 (horario de Brasilia, UTC-3) = 06:00 UTC. Fora da
-- janela de coleta incremental (19:00) e do pico operacional. O cron apenas
-- ENFILEIRA 'nomus-processos-full' (idempotente); o poll do PC executa.
--
-- APLICAR SO APOS 1 run full medido manualmente pelo botao do cockpit
-- ("medir antes de escalar"): confirmar tempo/volume da varredura completa
-- antes de cravar a cadencia. Ajustar o cron expr aqui se 03:00 nao servir.
--
-- Idempotente (unschedule antes de schedule). Aplicar via Node `pg`.
-- =====================================================================

do $$
begin
  begin
    perform cron.unschedule('coleta-nomus-processos-full');
  exception when others then null;
  end;

  perform cron.schedule(
    'coleta-nomus-processos-full',
    '0 6 * * *',
    $job$ select public.enfileirar_comando_local('nomus-processos-full'); $job$
  );
end;
$$;
