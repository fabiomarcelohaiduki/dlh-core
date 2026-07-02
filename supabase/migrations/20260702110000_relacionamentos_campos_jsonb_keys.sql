-- =====================================================================
-- Feature: Relacionamentos (GraphLink) - campos jsonb no picker de regras
--
-- Problema: chaves de match reais da DLH (uasg, processo/pregao, cnpj em
-- alguns casos) NAO sao colunas fisicas - vivem DENTRO da coluna jsonb
-- `payload_bruto`. O picker antigo (20260702100000) excluia jsonb por
-- completo, entao o humano nao tinha como cadastrar uma regra sobre uasg,
-- e uma regra escrita "na mao" apontando pra coluna inexistente
-- (ex.: numero_pregao) estourava 500 no dry-run.
--
-- Solucao config-driven (sem coluna nova, serve pra qualquer chave futura):
-- o picker passa a listar TAMBEM as chaves de topo de cada coluna jsonb,
-- no formato "coluna.chave" (ex.: "payload_bruto.uasg"). O motor
-- (relacionamentos-backfill / dry-run) ja entende esse dotted-path: le a
-- coluna fisica jsonb e extrai a chave em memoria.
--
-- Pecas (aditivo e idempotente - substitui as 2 RPCs por versoes plpgsql):
--   d) relacionamentos_campos_tabela(p_tabela): colunas fisicas escalares
--      + chaves de topo das colunas jsonb (amostradas, formato coluna.chave).
--   e) relacionamentos_tipos_campos(p_org_id): reusa (d) via lateral (DRY).
--
-- Guardas: p_tabela validado por regex antes do SQL dinamico (%I quota o
-- identificador; a regex e defesa extra). Amostra limitada a 500 linhas por
-- coluna jsonb (chave de match e estrutural - aparece nas primeiras linhas).
-- Colunas de conteudo pesado seguem 100% excluidas (texto/embedding/etc).
-- =====================================================================

-- e) RPC: colunas fisicas + chaves jsonb de UMA tabela do public.
create or replace function public.relacionamentos_campos_tabela(p_tabela text)
returns table (
  campo text,
  tipo_dado text
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_col text;
  v_sample constant int := 500;
begin
  -- Defesa: nome de tabela invalido nao chega ao SQL dinamico.
  if p_tabela is null or p_tabela !~ '^[a-z][a-z0-9_]{0,62}$' then
    return;
  end if;

  -- 1) Colunas fisicas escalares (mesma exclusao de conteudo pesado; jsonb
  --    sai daqui e entra na etapa 2 como chaves).
  return query
    select
      c.column_name::text as campo,
      c.data_type::text as tipo_dado
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = p_tabela
      and c.column_name not in
        ('id', 'texto', 'conteudo_verbatim', 'embedding', 'logo_base64')
      and c.data_type not in
        ('jsonb', 'USER-DEFINED', 'tsvector', 'bytea', 'ARRAY')
    order by c.ordinal_position;

  -- 2) Chaves de topo de cada coluna jsonb utilizavel, como "coluna.chave".
  --    Amostra v_sample linhas por coluna (chave estrutural aparece cedo).
  for v_col in
    select c.column_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = p_tabela
      and c.data_type = 'jsonb'
      and c.column_name not in ('conteudo_verbatim', 'embedding', 'logo_base64')
    order by c.ordinal_position
  loop
    return query execute format(
      'select %1$L || ''.'' || k as campo, ''jsonb''::text as tipo_dado
         from (
           select distinct jsonb_object_keys(%1$I) as k
           from (
             select %1$I
             from public.%2$I
             where %1$I is not null and jsonb_typeof(%1$I) = ''object''
             limit %3$s
           ) src
         ) chaves
        order by k',
      v_col, p_tabela, v_sample
    );
  end loop;

  return;
end;
$$;

revoke all on function public.relacionamentos_campos_tabela(text) from public;
revoke all on function public.relacionamentos_campos_tabela(text) from anon;
revoke all on function public.relacionamentos_campos_tabela(text) from authenticated;
grant execute on function public.relacionamentos_campos_tabela(text) to service_role;

-- d) RPC: tipos da org + campos de cada tabela_fonte. Reusa (e) por lateral
--    (DRY: uma unica definicao de "o que e campo utilizavel").
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
    f.campo,
    f.tipo_dado
  from public.config_tipos_no t
  cross join lateral public.relacionamentos_campos_tabela(t.tabela_fonte) f
  where t.org_id = p_org_id
    and t.tabela_fonte is not null
  order by t.tipo, f.campo;
$$;

revoke all on function public.relacionamentos_tipos_campos(uuid) from public;
revoke all on function public.relacionamentos_tipos_campos(uuid) from anon;
revoke all on function public.relacionamentos_tipos_campos(uuid) from authenticated;
grant execute on function public.relacionamentos_tipos_campos(uuid) to service_role;
