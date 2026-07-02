-- =====================================================================
-- Feature: Relacionamentos (GraphLink) - tipos de no administraveis
--
-- Objetivo: o mapeamento tipo de no -> tabela do substrato deixa de ser
-- hardcode (frontend CAMPOS_POR_TIPO + backfill resolverTabelaFonte) e
-- vira DADO em config_tipos_no.tabela_fonte. Com isso:
--   1) os dropdowns de campo das regras humanas listam as colunas REAIS
--      da tabela (via information_schema), eliminando campos fantasma;
--   2) uma fonte/tipo novo pode ser cadastrada pelo cockpit (tipo + tabela)
--      e os campos aparecem sozinhos, sem mexer em codigo.
--
-- Pecas (tudo aditivo e idempotente):
--   a) coluna config_tipos_no.tabela_fonte (text, nullable) + CHECK de formato;
--   b) re-seed dos 3 tipos internos que podem faltar em bancos antigos
--      (preco, politica, cotacao_diretriz) ja com tabela_fonte;
--   c) UPDATE do tabela_fonte dos 10 tipos canonicos onde ainda for null;
--   d) RPC relacionamentos_tipos_campos(p_org_id): tipos da org + colunas
--      reais de cada tabela_fonte (alimenta os selects do RegraForm);
--   e) RPC relacionamentos_campos_tabela(p_tabela): colunas de UMA tabela
--      (valida tabela_fonte no cadastro de tipo novo; vazio = tabela invalida).
--
-- As RPCs excluem colunas que nao servem como chave de match:
--   - bulk/conteudo: texto, payload_bruto, conteudo_verbatim, embedding,
--     logo_base64;
--   - 'id' (o backfill ja seleciona id; evitaria "select id, id");
--   - tipos pesados/nao-comparaveis: jsonb, vector (USER-DEFINED), tsvector,
--     bytea e arrays.
-- =====================================================================

-- a) Coluna + CHECK de formato (nome de tabela: minusculas/underscore).
alter table public.config_tipos_no
  add column if not exists tabela_fonte text;

alter table public.config_tipos_no
  drop constraint if exists config_tipos_no_tabela_fonte_formato;
alter table public.config_tipos_no
  add constraint config_tipos_no_tabela_fonte_formato
  check (tabela_fonte is null or tabela_fonte ~ '^[a-z][a-z0-9_]{0,62}$');

-- b) Re-seed dos 3 tipos internos (bancos antigos podem ter so 7 tipos).
insert into public.config_tipos_no
  (org_id, tipo, label, icone, cor, ordem, ativo, tabela_fonte)
select o.id, v.tipo, v.label, v.icone, v.cor, v.ordem, true, v.tabela_fonte
from public.org o
cross join (
  values
    ('preco', 'Preço', 'badge-dollar-sign', '#22d3ee', 8, 'sku_precos_calculados'),
    ('politica', 'Política', 'shield-check', '#84cc16', 9, 'politica_participacao'),
    ('cotacao_diretriz', 'Diretriz', 'scroll-text', '#f97316', 10, 'cotacao_diretrizes')
) as v (tipo, label, icone, cor, ordem, tabela_fonte)
on conflict (org_id, tipo) do nothing;

-- c) tabela_fonte dos tipos canonicos (mesmo mapeamento do backfill).
update public.config_tipos_no c
set tabela_fonte = v.tabela_fonte
from (
  values
    ('aviso', 'avisos'),
    ('processo', 'nomus_processos'),
    ('documento', 'documentos'),
    ('pessoa', 'nomus_pessoas'),
    ('produto', 'produtos'),
    ('linha', 'produto_linhas'),
    ('sku', 'produto_skus'),
    ('preco', 'sku_precos_calculados'),
    ('politica', 'politica_participacao'),
    ('cotacao_diretriz', 'cotacao_diretrizes')
) as v (tipo, tabela_fonte)
where c.tipo = v.tipo
  and c.tabela_fonte is null;

-- d) RPC: tipos da org + colunas reais de cada tabela_fonte.
create or replace function public.relacionamentos_tipos_campos(p_org_id uuid)
returns table (
  tipo text,
  tabela_fonte text,
  campo text,
  tipo_dado text
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    t.tipo,
    t.tabela_fonte,
    c.column_name::text as campo,
    c.data_type::text as tipo_dado
  from public.config_tipos_no t
  join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = t.tabela_fonte
  where t.org_id = p_org_id
    and t.tabela_fonte is not null
    and c.column_name not in
      ('id', 'texto', 'payload_bruto', 'conteudo_verbatim', 'embedding', 'logo_base64')
    and c.data_type not in ('jsonb', 'USER-DEFINED', 'tsvector', 'bytea', 'ARRAY')
  order by t.tipo, c.ordinal_position;
$$;

revoke all on function public.relacionamentos_tipos_campos(uuid) from public;
revoke all on function public.relacionamentos_tipos_campos(uuid) from anon;
revoke all on function public.relacionamentos_tipos_campos(uuid) from authenticated;
grant execute on function public.relacionamentos_tipos_campos(uuid) to service_role;

-- e) RPC: colunas de UMA tabela do public (validacao de tabela_fonte).
--    Resultado vazio = tabela inexistente ou sem coluna utilizavel (422 na Edge).
create or replace function public.relacionamentos_campos_tabela(p_tabela text)
returns table (
  campo text,
  tipo_dado text
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    c.column_name::text as campo,
    c.data_type::text as tipo_dado
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = p_tabela
    and c.column_name not in
      ('id', 'texto', 'payload_bruto', 'conteudo_verbatim', 'embedding', 'logo_base64')
    and c.data_type not in ('jsonb', 'USER-DEFINED', 'tsvector', 'bytea', 'ARRAY')
  order by c.ordinal_position;
$$;

revoke all on function public.relacionamentos_campos_tabela(text) from public;
revoke all on function public.relacionamentos_campos_tabela(text) from anon;
revoke all on function public.relacionamentos_campos_tabela(text) from authenticated;
grant execute on function public.relacionamentos_campos_tabela(text) to service_role;
