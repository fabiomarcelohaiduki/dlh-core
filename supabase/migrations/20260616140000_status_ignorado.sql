-- =====================================================================
-- Amplia o CHECK de documento_vinculos.status_extracao com 'ignorado'.
--
-- 'ignorado' = status TERMINAL aplicado MANUALMENTE pelo humano no cockpit
-- quando, ao avaliar um anexo em Erros/Inacessiveis, decide que ele e
-- dispensavel (ex: arquivo morto na origem que nao vale recuperar). O anexo
-- sai das listas e nao volta a ser processado.
--
-- Inerte por construcao (nao precisa mudar runner/descoberta):
--   - o runner so consome 'pendente' (e 'precisa_ocr' no passo OCR);
--   - a descoberta e ON CONFLICT DO NOTHING -> nao ressuscita o vinculo;
--   - o reprocesso manual so toca o status alvo selecionado.
-- Reversivel: o card "Ignorados" reprocessa ('ignorado' -> 'pendente').
--
-- Idempotente (drop + add); aplicado via pg (padrao do projeto).
-- =====================================================================
alter table public.documento_vinculos
  drop constraint if exists documento_vinculos_status_extracao_check;

alter table public.documento_vinculos
  add constraint documento_vinculos_status_extracao_check
  check (status_extracao = any (array[
    'pendente'::text,
    'extraido'::text,
    'herdado'::text,
    'erro'::text,
    'precisa_ocr'::text,
    'inobtenivel'::text,
    'ignorado'::text
  ]));
