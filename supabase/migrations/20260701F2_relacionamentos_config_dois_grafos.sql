-- =====================================================================
-- Feature: Relacionamentos V2 - F2 (dois grafos)
--
-- Migration ADITIVA e IDEMPOTENTE que estende public.config_relacionamentos
-- com os dois parametros que governam a nova experiencia de DOIS GRAFOS
-- (hierarquico + semantico), consumidos pela Edge relacionamentos-panorama
-- evoluida e pela MCP relacionamentos-buscar-split:
--
--   * cap_por_grafo (int, NULLABLE): teto de nos POR GRAFO. Tem precedencia
--     sobre o legado cap_panorama. Precedencia efetiva no codigo:
--         cap_por_grafo ?? cap_panorama ?? 200
--     Fica NULL ate a UI definir (mesma politica do cap_panorama legado),
--     de modo que o default interno (200) so vale quando ambos sao NULL.
--
--   * tipo_default_panorama (text, NOT NULL default 'hierarquico'):
--     tipo de relacionamento default do panorama quando o cliente NAO
--     informa ?tipo=. Enum logico via text + CHECK (nunca ENUM nativo,
--     PRD D.7): valores 'hierarquico' | 'semantico'.
--
-- Padrao: ADD COLUMN IF NOT EXISTS (nao dropa nada, nao quebra dados V1,
-- nao altera policies). O ADD COLUMN com default preenche as linhas
-- existentes de tipo_default_panorama; cap_por_grafo nasce NULL.
-- =====================================================================

alter table public.config_relacionamentos
  add column if not exists cap_por_grafo int;

alter table public.config_relacionamentos
  add column if not exists tipo_default_panorama text not null default 'hierarquico'
    check (tipo_default_panorama in ('hierarquico', 'semantico'));

comment on column public.config_relacionamentos.cap_por_grafo is
  'Relacionamentos V2 (dois grafos): teto de nos POR GRAFO. Precedencia no codigo: cap_por_grafo ?? cap_panorama ?? 200. NULL ate a UI definir.';

comment on column public.config_relacionamentos.tipo_default_panorama is
  'Relacionamentos V2 (dois grafos): tipo de relacionamento default do panorama quando ?tipo= ausente (hierarquico|semantico).';
