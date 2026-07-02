-- =====================================================================
-- Feature: Relacionamentos V2 - Fase 0 (migrations aditivas)
-- Campos visuais em public.config_tipos_no + backfill paleta DLH4.
--
-- Contexto (roadmap feature-relacionamentos-v2.md §4.14, §4.15):
--   O grafo estilo Obsidian usa abreviacoes para rotulos longos
--   (abreviacao_padrao) e uma cor semantica calibrada por tipo de no
--   (cor_semantica) na estetica de neuronios interconectados. Estas
--   colunas convivem com a coluna legada 'cor' (nao removida nesta fase).
--
-- Backfill: preenche os 10 tipos do seed com a PALETA CANONICA DLH4,
-- apenas onde os campos ainda estao NULL. A clausula WHERE ... IS NULL
-- garante idempotencia: rodar duas vezes seguidas nao sobrescreve valor
-- ja definido (nem o backfill, nem edicoes humanas posteriores).
--
-- Padrao: ADITIVA e IDEMPOTENTE (ADD COLUMN IF NOT EXISTS + UPDATE
-- protegido por WHERE IS NULL). UNIQUE (org_id, tipo) preservado;
-- nenhuma policy RLS alterada.
-- =====================================================================

alter table public.config_tipos_no
  add column if not exists abreviacao_padrao text null;

alter table public.config_tipos_no
  add column if not exists cor_semantica text null;

comment on column public.config_tipos_no.abreviacao_padrao is
  'Relacionamentos V2: abreviacao padrao do rotulo do no no grafo (rotulos longos, §4.14).';
comment on column public.config_tipos_no.cor_semantica is
  'Relacionamentos V2: cor semantica DLH4 do no no grafo estilo Obsidian (§4.15).';

-- ---------------------------------------------------------------------
-- Backfill dos 10 tipos com a paleta canonica DLH4.
-- Casa por (tipo) dentro de cada linha existente; so preenche onde
-- abreviacao_padrao E cor_semantica estao NULL (idempotente).
-- ---------------------------------------------------------------------
update public.config_tipos_no t
set abreviacao_padrao = v.abreviacao_padrao,
    cor_semantica     = v.cor_semantica
from (
  values
    ('produto',          'Prod', '#7DD3FC'),
    ('categoria',        'Cat',  '#A78BFA'),
    ('marca',            'Mrc',  '#F472B6'),
    ('fornecedor',       'Forn', '#FB923C'),
    ('atributo',         'Atr',  '#34D399'),
    ('documento',        'Doc',  '#FBBF24'),
    ('tag',              'Tag',  '#94A3B8'),
    ('preco',            'Pre',  '#22D3EE'),
    ('politica',         'Pol',  '#F87171'),
    ('cotacao_diretriz', 'Cot',  '#C084FC')
) as v (tipo, abreviacao_padrao, cor_semantica)
where t.tipo = v.tipo
  and t.abreviacao_padrao is null
  and t.cor_semantica is null;
