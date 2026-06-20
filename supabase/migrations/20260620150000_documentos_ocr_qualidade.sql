-- =====================================================================
-- documentos — PORTAO DE QUALIDADE do OCR (Sprint 4, decisao 7: minimo primeiro).
--
-- PDF escaneado/imagem vai para a fila 'precisa_ocr' e o passo OCR (Tika full)
-- grava o texto em documentos.texto com usou_ocr=true — SEM medir a qualidade.
-- OCR ruim gera texto corrompido: o numero pode existir porem ilegivel, e o
-- grep reverso da fidelidade passa a ser FRACO (falso ok / falso suspeito).
--
-- Esta migration adiciona o portao de qualidade (so a MEDIDA + flag; OCR
-- table-aware/layout-preserving fica para depois, condicionado ao volume —
-- decisao 7):
--   - ocr_confianca: razao de caracteres "esperados" (0..1), null quando o
--     documento nao usou OCR.
--   - ocr_baixa_confianca: true quando a confianca ficou abaixo do limiar (ou o
--     texto e curto demais) -> ROTEAR AO HUMANO; a fidelidade NAO confia no grep
--     desse documento (gate de qualidade precede o grep) e o cockpit sinaliza.
--
-- Aditivo/idempotente. Aplicar via node pg direto (SUPABASE_DB_URL session
-- pooler), NUNCA supabase db push.
-- =====================================================================

alter table public.documentos
  add column if not exists ocr_confianca numeric;

alter table public.documentos
  add column if not exists ocr_baixa_confianca boolean not null default false;

-- Fila de revisao humana: documentos com OCR de baixa confianca.
create index if not exists documentos_ocr_baixa_confianca_idx
  on public.documentos (ocr_baixa_confianca)
  where ocr_baixa_confianca = true;
