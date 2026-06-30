-- =====================================================================
-- Migration: DROP das RPCs de disparo de extracao/OCR via GitHub Actions
--
-- A extracao manual (Tika "Extrair pendentes" + OCR "Extrair OCR") migrou
-- do GitHub Actions para o PC: as Edges extracao-disparar e ocr-disparar
-- agora ENFILEIRAM 'tika-ocr' na fila comando_local (o PC executa via
-- extrair-tika.ps1, que roda Tika+OCR juntos). Com isso, estas duas RPCs
-- ficaram sem nenhum caller:
--   - disparar_workflow_extracao()  (criada em 20260610080000_disparar_extracao.sql)
--   - disparar_workflow_ocr()       (criada em 20260615340000_disparar_ocr.sql)
--
-- Ambas acionavam workflows GitHub Actions (extrair-anexos.yml / extrair-ocr.yml)
-- que tambem ja nao existem. Removemos o codigo morto para nao deixar lixo.
--
-- Idempotente (drop if exists). Aplicar via Node `pg` (SUPABASE_DB_URL),
-- padrao do projeto.
-- =====================================================================

drop function if exists public.disparar_workflow_extracao();
drop function if exists public.disparar_workflow_ocr();
