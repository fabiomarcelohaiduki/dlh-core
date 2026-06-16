-- Passo OCR isolado (decisao Fabio 2026-06-15): separa o pipeline RAPIDO
-- (PDF nativo/docx/xlsx, OCR off) do OCR caro (escaneado/imagem). O passo
-- rapido marca os anexos que so dao texto via OCR com status 'precisa_ocr';
-- um run dedicado (EXTRACAO_MODO=ocr, lote pequeno + healthcheck do Tika)
-- drena essa fila sem que um escaneado grande contamine o pipeline rapido.
--
-- Idempotente: dropa o check inline (nome padrao do Postgres) e recria com
-- o novo valor permitido.

alter table public.documento_vinculos
  drop constraint if exists documento_vinculos_status_extracao_check;

alter table public.documento_vinculos
  add constraint documento_vinculos_status_extracao_check
  check (status_extracao in ('pendente', 'extraido', 'herdado', 'erro', 'precisa_ocr'));
