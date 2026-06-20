-- =====================================================================
-- documento_item_suspeitas — campos de CURADORIA humana (Sprint 3).
--
-- A fila de revisao de extracao (criada em 20260620120100) nasce 'pendente'
-- escrita PELO SERVIDOR (fidelidade / recall_effecti). A Sprint 3 abre o
-- consumidor: o humano CURA cada linha no cockpit (confirmar / corrigir /
-- descartar). Esta migration adiciona os campos da curadoria:
--   - descricao_corrigida / numero_corrigido: o valor CORRETO informado pelo
--     humano em 'corrigido' (snapshot que sobrevive a re-extracao).
--   - curado_por: quem curou (curado_em ja existe).
--
-- REAPLICACAO POS RE-EXTRACAO: documento_itens e delete-then-insert a cada run.
-- A v1-documento-itens-gravar passa a consultar esta fila e NAO re-marca como
-- 'suspeito' um item que o humano ja CUROU (confirmado/corrigido/descartado),
-- casando pelo snapshot da descricao. A correcao humana sobrevive a re-extracao.
--
-- Aditivo/idempotente (add column if not exists). Aplicar via node pg direto
-- (SUPABASE_DB_URL session pooler), NUNCA supabase db push.
-- =====================================================================

alter table public.documento_item_suspeitas
  add column if not exists descricao_corrigida text;

alter table public.documento_item_suspeitas
  add column if not exists numero_corrigido text;

alter table public.documento_item_suspeitas
  add column if not exists curado_por text;

-- Reaplicacao: a v1-documento-itens-gravar busca as curadas de um documento por
-- (documento_id, status) para suprimir o re-flag. Indice parcial das curadas.
create index if not exists documento_item_suspeitas_curadas_idx
  on public.documento_item_suspeitas (documento_id)
  where status in ('confirmado', 'corrigido', 'descartado');
