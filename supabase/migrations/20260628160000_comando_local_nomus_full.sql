-- =====================================================================
-- Migration: novo comando 'nomus-processos-full' na fila comando_local.
--
-- MOTIVO (28/06): a coleta incremental de Nomus pega so NOVOS por id (id >
-- watermark). Processos nao tem 2a passada por dataModificacao (so pessoas),
-- entao MUDANCAS DE ETAPA em processos antigos nunca sao re-capturadas pela
-- coleta diaria. A re-varredura FULL re-coleta todas as paginas dentro do
-- corte de idade (janela_dias) e atualiza esses processos.
--
-- O QUE MUDA:
--   1. CHECK de comando_local.comando passa a aceitar 'nomus-processos-full'.
--      O PC mapeia para coletar-nomus.ps1 -Recurso processos -Modo full.
--
-- O cron dedicado da re-varredura vem em migration separada (apos 1 run
-- medido manualmente, conforme "medir antes de escalar").
--
-- Idempotente. Aplicar via Node `pg` (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

alter table public.comando_local
  drop constraint if exists comando_local_comando_check;

alter table public.comando_local
  add constraint comando_local_comando_check
  check (comando in ('nomus-processos', 'nomus-pessoas', 'nomus-processos-full', 'tika-ocr'));

comment on table public.comando_local is
  'Fila de comandos que o cockpit enfileira e o PC local (servico de poll) executa: coleta Nomus (incremental e re-varredura full) e extracao Tika/OCR migradas para o PC pos-Actions. pendente->executando->concluido|erro. RLS sem policy (service-role only via Edges comando-local-enfileirar e comando-local-fila).';
