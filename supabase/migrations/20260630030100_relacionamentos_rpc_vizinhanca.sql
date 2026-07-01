-- =====================================================================
-- Feature: Relacionamentos (Documento feature-relacionamentos.md / SPEC secao 2.4.1)
-- Migration parte 2/3: RPC SECURITY DEFINER relacoes_vizinhanca.
--
-- Implementada em SQL puro com CTE RECURSIVE bidirecional, filtra
-- status='confirmado', aplica DISTINCT nos nos retornados e clampa
-- p_profundidade em [0, 5] (teto documentado).
--
-- Retorna setof vizinho_row (tipo text, id text, profundidade int,
-- caminho text[]). Recebe p_tipo e p_id em text para suportar
-- identificadores nao-UUID (CNPJ etc.).
--
-- Padrao de permissao (espelho de disparar_triagem_descarte):
--   SECURITY DEFINER + SET search_path = public, pg_temp
--   REVOKE EXECUTE FROM public, anon, authenticated
--   GRANT EXECUTE TO service_role
--
-- Idempotente: create or replace function + revoke/grant idempotentes.
-- Substitui versoes anteriores sem dependencias externas alem da
-- tabela public.relacoes (criada em 20260630020000_relacionamentos_tabelas.sql).
--
-- Decisoes de implementacao (eficiencia / robustez):
--   * Step recursivo decomposto em dois LEGS indexaveis (origem e
--     destino) unidos por UNION, permitindo ao planner usar
--     independentemente idx_relacoes_origem E idx_relacoes_destino
--     (em contraste com o OR no JOIN, que geralmente colapsa para
--     uma unica varredura).
--   * LATERAL materializa (target_tipo, target_id) UMA UNICA VEZ por
--     candidato (em vez do CASE duplicado 4x na versao anterior).
--   * Deteccao de ciclos usa delimitador '>' em ambas as pontas do
--     agulha de busca para evitar falso-positivo por substring
--     (ex.: 'aviso:123' casar em '>aviso:1234>').
--   * WHERE aplica clamp [0,5] via p.profundidade_cap ANTES da
--     expansao (a recursao nao gera niveis alem do teto).
-- =====================================================================

create or replace function public.relacoes_vizinhanca(
  p_tipo text,
  p_id text,
  p_profundidade int default 2
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
       where r.status = 'confirmado'
         and r.origem_tipo = w.tipo and r.origem_id = w.id
      union
      -- leg 2: r.destino = w  =>  emit (r.origem_tipo, r.origem_id)
      select r.origem_tipo as target_tipo, r.origem_id as target_id
        from public.relacoes r
       where r.status = 'confirmado'
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

comment on function public.relacoes_vizinhanca(text, text, int) is
  'Relacionamentos: retorna vizinhanca bidirecional do no (p_tipo, p_id) ate p_profundidade (clampada em [0, 5]) usando CTE RECURSIVE sobre public.relacoes filtrando status=''confirmado''. DISTINCT por (tipo,id) preservando o caminho de menor profundidade. SECURITY DEFINER; uso restrito a service_role.';

revoke all on function public.relacoes_vizinhanca(text, text, int) from public;
revoke execute on function public.relacoes_vizinhanca(text, text, int) from anon;
revoke execute on function public.relacoes_vizinhanca(text, text, int) from authenticated;
grant execute on function public.relacoes_vizinhanca(text, text, int) to service_role;
