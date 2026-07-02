-- =====================================================================
-- Feature: Relacionamentos V2 - Fase 0 (migrations aditivas)
-- Campos de feedback inline de aresta em public.relacoes.
--
-- Contexto (roadmap feature-relacionamentos-v2.md §4.2, §6.6):
--   A V2 abandona o workflow de aprovacao. Toda aresta nasce OK e
--   visivel; a revisao humana serve para registrar "ja vi" (visto_por
--   + visto_em) e sinalizar "esta errada" (incorreta + incorreta_motivo,
--   motivo obrigatorio na borda/UI). Estes campos convivem com o legado
--   relacoes.status (que deixa de guiar a UX, sem ser removido nesta
--   fase - §7.4).
--
-- Padrao: ADITIVA e IDEMPOTENTE (ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS). Nenhuma policy RLS e alterada;
-- relacoes_select_allowlist permanece intacta.
-- =====================================================================

alter table public.relacoes
  add column if not exists visto_por text null;

alter table public.relacoes
  add column if not exists visto_em timestamptz null;

alter table public.relacoes
  add column if not exists incorreta boolean not null default false;

alter table public.relacoes
  add column if not exists incorreta_motivo text null;

comment on column public.relacoes.visto_por is
  'Relacionamentos V2: identificador do humano que revisou a aresta (registro "ja vi", §4.2).';
comment on column public.relacoes.visto_em is
  'Relacionamentos V2: quando a aresta foi marcada como vista (§4.2).';
comment on column public.relacoes.incorreta is
  'Relacionamentos V2: flag simples de aresta incorreta (nasce false; humano sinaliza, §4.2).';
comment on column public.relacoes.incorreta_motivo is
  'Relacionamentos V2: motivo da incorrecao (obrigatorio na borda quando incorreta=true, §4.2).';

-- Indice para filtrar arestas sinalizadas como incorretas (revisao humana).
create index if not exists idx_relacoes_incorreta
  on public.relacoes (incorreta);

-- Indice para filtrar/ordenar por "ja revisado" vs "nao revisado" (§4.2).
create index if not exists idx_relacoes_visto_em
  on public.relacoes (visto_em);
