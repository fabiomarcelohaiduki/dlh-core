-- =====================================================================
-- Feature: Relacionamentos V2 - Fase 0 (migrations aditivas)
-- Adiciona a coluna tipo_relacionamento em public.relacoes.
--
-- Contexto (roadmap feature-relacionamentos-v2.md §2, §7.2, §7.8):
--   A V2 separa as arestas em 2 tipos explicitos - hierarquico
--   (estrutural, campo-a-campo) e semantico (por conteudo/embedding) -
--   para poder alimentar os dois grafos distintos (§4.11) sem heuristica
--   fragil. A decisao do gate (§7.8.1) foi por CAMPO EXPLICITO.
--
-- Enum logico via text + CHECK (nunca ENUM nativo do Postgres, PRD D.7).
-- DEFAULT 'semantico': arestas legadas sem classificacao ficam neutras
-- ate o backfill deterministico reclassificar por metodo (migration
-- ..._tipo_relacionamento_backfill.sql).
--
-- Padrao: ADITIVA e IDEMPOTENTE (ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS). NAO dropa nada, nao quebra dados V1,
-- nao altera policies (relacoes_select_allowlist permanece intacta).
-- =====================================================================

alter table public.relacoes
  add column if not exists tipo_relacionamento text not null default 'semantico'
    check (tipo_relacionamento in ('hierarquico','semantico'));

comment on column public.relacoes.tipo_relacionamento is
  'Relacionamentos V2: tipo explicito da aresta (hierarquico=estrutural campo-a-campo; semantico=por conteudo/embedding). Alimenta os dois grafos distintos (§4.11).';

-- Indices para varredura por tipo + ponta da aresta (subgrafo por tipo,
-- travessia hierarquica ou semantica isolada - §7.1 eficiencia).
create index if not exists idx_relacoes_tipo_origem
  on public.relacoes (tipo_relacionamento, origem_tipo, origem_id);

create index if not exists idx_relacoes_tipo_destino
  on public.relacoes (tipo_relacionamento, destino_tipo, destino_id);
