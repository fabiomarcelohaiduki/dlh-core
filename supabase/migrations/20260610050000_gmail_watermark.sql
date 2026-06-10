-- =====================================================================
-- Fonte 'gmail' — JANELA DE COLETA INCREMENTAL DE DOIS LADOS (camada 1).
--   Ate aqui a coleta usava SEMPRE after:<data_inicial> (janela fixa): todo
--   run re-varria todos os emails desde a data; so o dedup da fila
--   (fonte, message_id, nome) evitava reprocessar. Caro e nao escalavel.
--
--   Duas marcas d'agua no singleton gmail_config controlam a janela:
--     coletado_ate    DATE  -> ponto mais RECENTE ja coberto (avanca p/ hoje
--                              a cada coleta concluida). A query de NOVOS parte
--                              de coletado_ate - 1 dia (overlap p/ nao perder a
--                              borda; o dedup absorve a repeticao).
--     coletado_desde  DATE  -> data mais ANTIGA ja coberta. So importa quando o
--                              usuario BAIXA data_inicial: ai roda uma query de
--                              ANTIGOS [data_inicial, coletado_desde] p/ buscar
--                              os emails historicos ate a nova data. Ao concluir,
--                              coletado_desde recua p/ min(coletado_desde,
--                              data_inicial).
--
--   NULL em ambas = nunca coletou com sucesso -> primeira coleta usa a janela
--   antiga (after:<data_inicial>), e o fechar grava as marcas pela 1a vez.
--
--   DDL idempotente (if not exists). Sem backfill das marcas: a 1a coleta
--   concluida apos esta migration ja popula coletado_ate/coletado_desde.
-- =====================================================================

alter table public.gmail_config
  add column if not exists coletado_ate   date,
  add column if not exists coletado_desde date;

comment on column public.gmail_config.coletado_ate is
  'Marca d''agua: data mais recente ja coberta pela coleta. Query de NOVOS parte daqui (-1 dia de overlap). NULL = nunca coletou.';
comment on column public.gmail_config.coletado_desde is
  'Marca d''agua: data mais antiga ja coberta. Backfill de ANTIGOS roda quando data_inicial < coletado_desde. NULL = nunca coletou.';
