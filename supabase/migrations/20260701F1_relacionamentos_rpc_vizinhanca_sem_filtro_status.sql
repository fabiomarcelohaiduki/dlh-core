-- =====================================================================
-- Feature: Relacionamentos V2 - F1 (RPC vizinhanca sem filtro status)
--
-- DROP FUNCTION + CREATE FUNCTION da RPC SECURITY DEFINER
-- public.relacoes_vizinhanca, removendo o filtro status='confirmado'
-- (RF-33). Na V2 o legado relacoes.status deixa de guiar a UX: toda
-- aresta nasce OK e visivel; a revisao humana marca "incorreta" para
-- suprimir. Portanto a vizinhanca:
--   * NAO filtra mais por status='confirmado';
--   * passa a EXCLUIR arestas sinalizadas como incorreta=true;
--   * aceita/propaga o parametro opcional p_tipo_relacionamento
--     ('hierarquico'|'semantico'): quando informado, restringe a
--     travessia as arestas daquele tipo; quando NULL, considera todas.
--
-- Compatibilidade com os 5 callers (relacionamentos-vizinhanca,
-- relacionamentos-panorama, v1-relacionamentos-no,
-- v1-relacionamentos-vizinhos, v1-relacionamentos-buscar): o nome
-- (relacoes_vizinhanca), os parametros existentes (p_tipo, p_id,
-- p_profundidade) e o tipo de retorno (setof vizinho_row) permanecem
-- inalterados. O novo parametro p_tipo_relacionamento e OPCIONAL (DEFAULT
-- NULL), de modo que os callers que passam apenas os 3 argumentos
-- historicos continuam funcionando sem qualquer alteracao.
--
-- Como a assinatura muda (novo parametro), a substituicao e feita por
-- DROP FUNCTION seguido de CREATE FUNCTION (create or replace nao permite
-- alterar a lista de parametros). Nenhum TRIGGER e criado nesta migration.
--
-- Padrao de permissao (espelho da versao anterior):
--   SECURITY DEFINER + SET search_path = public, pg_temp
--   REVOKE EXECUTE FROM public, anon, authenticated
--   GRANT EXECUTE TO service_role
-- =====================================================================

drop function if exists public.relacoes_vizinhanca(text, text, int);

create function public.relacoes_vizinhanca(
  p_tipo text,
  p_id text,
  p_profundidade int default 2,
  p_tipo_relacionamento text default null
) returns table (tipo text, id text, profundidade int, caminho text[])
language sql
security definer
set search_path = public, pg_temp
as $$
with recursive
  params as (
    -- params: nao-recursiva, avaliada UMA unica vez antes da recursao.
    -- Carrega a ancora (p_tipo, p_id) e o cap [0,5].
    select
      p_tipo                                                       as tipo,
      p_id                                                         as id,
      greatest(0, least(coalesce(p_profundidade, 2), 5))            as profundidade_cap
  ),
  walk (tipo, id, profundidade, caminho, rn_path) as (
    -- Ancora: o proprio no de origem, profundidade 0.
    select
      p.tipo,
      p.id,
      0,
      array[]::text[],
      '>' || p.tipo || ':' || p.id
    from params p
    union all
    -- Passo recursivo bidirecional decomposto em dois LEGS indexados:
    --   leg 1 (origem=:w): cada relacao cuja origem == w emite destino.
    --   leg 2 (destino=:w): cada relacao cujo destino == w emite origem.
    -- Cada leg pode usar seu proprio B-tree (idx_relacoes_origem ou
    -- idx_relacoes_destino). O UNION interno (sem ALL) dedupa self-loops
    -- onde origem == destino (edge que aponta para o proprio no).
    --
    -- V2: sem filtro status='confirmado'. Excluimos arestas incorreta=true
    -- e, quando p_tipo_relacionamento for informado, restringimos ao tipo
    -- de relacionamento pedido ('hierarquico'|'semantico').
    select
      v.target_tipo                                                as tipo,
      v.target_id                                                  as id,
      w.profundidade + 1                                           as profundidade,
      w.caminho || v.target_tipo                                   as caminho,
      w.rn_path || '>' || v.target_tipo || ':' || v.target_id      as rn_path
    from walk w
    cross join params p
    cross join lateral (
      -- leg 1: r.origem = w  =>  emit (r.destino_tipo, r.destino_id)
      select r.destino_tipo as target_tipo, r.destino_id as target_id
        from public.relacoes r
       where r.incorreta = false
         and (p_tipo_relacionamento is null
              or r.tipo_relacionamento = p_tipo_relacionamento)
         and r.origem_tipo = w.tipo and r.origem_id = w.id
      union
      -- leg 2: r.destino = w  =>  emit (r.origem_tipo, r.origem_id)
      select r.origem_tipo as target_tipo, r.origem_id as target_id
        from public.relacoes r
       where r.incorreta = false
         and (p_tipo_relacionamento is null
              or r.tipo_relacionamento = p_tipo_relacionamento)
         and r.destino_tipo = w.tipo and r.destino_id = w.id
    ) v
    where w.profundidade < p.profundidade_cap
      -- Guarda contra ciclos usando delimitador '>' em ambas as pontas
      -- do needle para evitar falso-positivo por substring
      -- (ex.: 'aviso:123' casando em '>aviso:1234>').
      and position(('>' || v.target_tipo || ':' || v.target_id || '>')
                   in (w.rn_path || '>')) = 0
  ),
  -- DISTINCT nos nos retornados: para cada (tipo, id) emitimos o caminho
  -- de menor profundidade (mais curto) - row_number e equivalente a
  -- DISTINCT ON (tipo, id) ORDER BY profundidade, mas mantem a forma
  -- canonica do projeto para revisoes futuras.
  walk_distinct as (
    select
      tipo,
      id,
      profundidade,
      caminho,
      row_number() over (
        partition by tipo, id
        order by profundidade asc
      ) as rn
    from walk
  )
select
  wd.tipo,
  wd.id,
  wd.profundidade,
  wd.caminho
from walk_distinct wd
where wd.rn = 1
order by wd.profundidade asc, wd.tipo asc, wd.id asc;
$$;

comment on function public.relacoes_vizinhanca(text, text, int, text) is
  'Relacionamentos V2: retorna vizinhanca bidirecional do no (p_tipo, p_id) ate p_profundidade (clampada em [0, 5]) usando CTE RECURSIVE sobre public.relacoes. NAO filtra status; exclui arestas incorreta=true e, quando p_tipo_relacionamento (hierarquico|semantico) e informado, restringe a travessia a esse tipo. DISTINCT por (tipo,id) preservando o caminho de menor profundidade. SECURITY DEFINER; uso restrito a service_role.';

revoke all on function public.relacoes_vizinhanca(text, text, int, text) from public;
revoke execute on function public.relacoes_vizinhanca(text, text, int, text) from anon;
revoke execute on function public.relacoes_vizinhanca(text, text, int, text) from authenticated;
grant execute on function public.relacoes_vizinhanca(text, text, int, text) to service_role;
