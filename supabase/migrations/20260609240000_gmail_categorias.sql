-- =====================================================================
-- Fonte 'gmail' — CATEGORIAS a excluir da coleta (camada 1).
--   As guias do Gmail (Promoções, Social, Atualizações, Fóruns) NAO sao
--   labels comuns: -label:"Promoções" nao as exclui. O correto e
--   -category:<slug> (slug fixo em ingles). Diferente das labels (cadastro
--   livre em gmail_labels), as categorias sao um conjunto FIXO e conhecido,
--   entao viram uma SELECAO (array de slugs) no singleton gmail_config.
--
--   O runner monta a query: after:<data> [-label:"X" ...] [-category:<slug> ...].
--
--   Migra as labels-categoria ja cadastradas (Promoções/Social/...) para a
--   nova coluna e as remove de gmail_labels, evitando duplicidade na UI.
--   DDL idempotente (if not exists); o seed so popula se a coluna esta vazia.
-- =====================================================================

alter table public.gmail_config
  add column if not exists categorias_excluidas text[] not null default '{}'::text[];

comment on column public.gmail_config.categorias_excluidas is
  'Slugs de categoria do Gmail a EXCLUIR (promotions/social/updates/forums). Viram -category:<slug> na query do runner.';

-- Migra labels que sao categorias para a nova coluna (so se ainda vazia).
update public.gmail_config gc
set categorias_excluidas = sub.cats,
    atualizado_em = now()
from (
  select coalesce(array_agg(distinct m.slug), '{}'::text[]) as cats
  from public.gmail_labels gl
  join (values
    ('promoções','promotions'),('promocoes','promotions'),('promotions','promotions'),
    ('social','social'),
    ('atualizações','updates'),('atualizacoes','updates'),('updates','updates'),
    ('fóruns','forums'),('foruns','forums'),('forums','forums')
  ) as m(nome, slug) on lower(btrim(gl.label)) = m.nome
  where gl.ativo
) sub
where gc.id = true
  and (gc.categorias_excluidas is null or gc.categorias_excluidas = '{}'::text[]);

-- Remove as labels-categoria da blacklist de labels (agora vivem em categorias_excluidas).
delete from public.gmail_labels
where lower(btrim(label)) in
  ('promoções','promocoes','promotions','social',
   'atualizações','atualizacoes','updates','fóruns','foruns','forums');
