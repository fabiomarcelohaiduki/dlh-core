-- =====================================================================
-- Sub-filtro de RECURSO na guia "Dados" (espelho da guia "Execuções").
--
-- A guia Execuções, ao selecionar a fonte Nomus, mostra pílulas de recurso
-- (Processos / Pessoas) e filtra a lista por elas. A guia Dados tinha só o
-- filtro de fonte. Aqui a lista mestra ganha o MESMO sub-filtro:
--   - as RPCs de pagina (listar / por_execucao) aceitam p_recurso e filtram
--     v.recurso = p_recurso (server-side, para o keyset não pular registros);
--   - as contagens passam a quebrar por (fonte, recurso) para alimentar as
--     pílulas com contagem real (Nomus = processos + pessoas).
--
-- A view vw_coleta_registros_mestra já carrega `recurso` (re-ancorada em
-- 20260629100000); aqui só estendemos as funções que a consomem. O contrato
-- de fonte/recurso é a allowlist RECURSO_POR_FONTE da Edge.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Pagina cumulativa: + p_recurso (filtra v.recurso quando informado). A
-- assinatura muda (6 -> 7 args), exige DROP antes do CREATE. Demais filtros,
-- keyset e clamp idênticos a 20260629130000.
-- ---------------------------------------------------------------------
drop function if exists public.coleta_registros_listar(text, text, text, timestamptz, text, integer);

create function public.coleta_registros_listar(
  p_fonte text default null,
  p_recurso text default null,
  p_status text default null,
  p_busca text default null,
  p_cursor_captado_em timestamptz default null,
  p_cursor_id_composto text default null,
  p_limit integer default 50
)
returns table (
  fonte                      text,
  recurso                    text,
  registro_origem_id         text,
  id_composto                text,
  titulo_curto               text,
  busca_texto                text,
  captado_em                 timestamptz,
  qtd_documentos             bigint,
  qtd_pendentes              bigint,
  qtd_erros                  bigint,
  qtd_ignorado               bigint,
  rep_id                     uuid,
  rep_nome_anexo             text,
  rep_documento_id           uuid,
  status_indexacao_agregado  text,
  efeito                     text
)
language sql
stable
as $$
  select
    v.fonte,
    v.recurso,
    v.registro_origem_id,
    v.id_composto,
    v.titulo_curto,
    v.busca_texto,
    v.captado_em,
    v.qtd_documentos,
    v.qtd_pendentes,
    v.qtd_erros,
    v.qtd_ignorado,
    v.rep_id,
    v.rep_nome_anexo,
    v.rep_documento_id,
    v.status_indexacao_agregado,
    null::text as efeito
  from public.vw_coleta_registros_mestra v
  where (p_fonte is null or v.fonte = p_fonte)
    and (p_recurso is null or v.recurso = p_recurso)
    and (p_status is null or v.status_indexacao_agregado = p_status)
    and (
      p_busca is null
      or v.busca_texto ilike
           '%' || replace(replace(replace(left(p_busca, 200), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           escape '\'
    )
    and (
      p_cursor_captado_em is null
      or v.captado_em < p_cursor_captado_em
      or (v.captado_em = p_cursor_captado_em and v.id_composto > p_cursor_id_composto)
    )
  order by v.captado_em desc, v.id_composto asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function public.coleta_registros_listar is
  'Uma pagina (keyset captado_em DESC, id_composto ASC) da lista mestra cumulativa da Coleta. Filtros fonte/recurso/status e busca (ilike escapado, 200 chars) em SQL; efeito NULL nesta rota; clamp [1,200]. Chamada pela Edge coleta-registros via service_role.';

revoke all on function public.coleta_registros_listar(text, text, text, text, timestamptz, text, integer) from anon, authenticated;
grant execute on function public.coleta_registros_listar(text, text, text, text, timestamptz, text, integer) to service_role;

-- ---------------------------------------------------------------------
-- Pagina por execucao: + p_recurso (mesma semantica). A assinatura muda
-- (7 -> 8 args), exige DROP antes do CREATE.
-- ---------------------------------------------------------------------
drop function if exists public.coleta_registros_por_execucao(uuid, text, text, text, timestamptz, text, integer);

create function public.coleta_registros_por_execucao(
  p_execucao_id uuid,
  p_fonte text default null,
  p_recurso text default null,
  p_status text default null,
  p_busca text default null,
  p_cursor_captado_em timestamptz default null,
  p_cursor_id_composto text default null,
  p_limit integer default 50
)
returns table (
  fonte                      text,
  recurso                    text,
  registro_origem_id         text,
  id_composto                text,
  titulo_curto               text,
  busca_texto                text,
  captado_em                 timestamptz,
  qtd_documentos             bigint,
  qtd_pendentes              bigint,
  qtd_erros                  bigint,
  qtd_ignorado               bigint,
  rep_id                     uuid,
  rep_nome_anexo             text,
  rep_documento_id           uuid,
  status_indexacao_agregado  text,
  efeito                     text
)
language sql
stable
as $$
  select
    v.fonte,
    v.recurso,
    v.registro_origem_id,
    v.id_composto,
    v.titulo_curto,
    v.busca_texto,
    v.captado_em,
    v.qtd_documentos,
    v.qtd_pendentes,
    v.qtd_erros,
    v.qtd_ignorado,
    v.rep_id,
    v.rep_nome_anexo,
    v.rep_documento_id,
    v.status_indexacao_agregado,
    r.efeito
  from public.execucao_registros r
  join public.vw_coleta_registros_mestra v
    on v.fonte = r.fonte
   and v.recurso = r.recurso
   and v.registro_origem_id = r.registro_origem_id
  where r.execucao_id = p_execucao_id
    and (p_fonte is null or v.fonte = p_fonte)
    and (p_recurso is null or v.recurso = p_recurso)
    and (p_status is null or v.status_indexacao_agregado = p_status)
    and (
      p_busca is null
      or v.busca_texto ilike
           '%' || replace(replace(replace(left(p_busca, 200), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           escape '\'
    )
    and (
      p_cursor_captado_em is null
      or v.captado_em < p_cursor_captado_em
      or (v.captado_em = p_cursor_captado_em and v.id_composto > p_cursor_id_composto)
    )
  order by v.captado_em desc, v.id_composto asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function public.coleta_registros_por_execucao is
  'Uma pagina (keyset captado_em DESC, id_composto ASC) da lista mestra recortada nos registros que a execucao tocou (INNER JOIN ao ledger pela tripla fonte/recurso/registro_origem_id), com efeito novo|atualizado. Aceita sub-filtro p_recurso. Chamada pela Edge coleta-registros via service_role.';

revoke all on function public.coleta_registros_por_execucao(uuid, text, text, text, text, timestamptz, text, integer) from anon, authenticated;
grant execute on function public.coleta_registros_por_execucao(uuid, text, text, text, text, timestamptz, text, integer) to service_role;

-- ---------------------------------------------------------------------
-- Contagens por (fonte, recurso): alimenta os chips de fonte (somando os
-- recursos de cada fonte na Edge) E as pílulas de recurso. Substitui a versao
-- por-fonte (20260629130000); a coluna `recurso` entra no output -> DROP antes
-- do CREATE. As 4 fontes sempre aparecem (left join sobre a lista fixa), mas
-- linhas por recurso so existem quando ha registro daquele recurso.
-- ---------------------------------------------------------------------
drop function if exists public.coleta_registros_contagens();

create function public.coleta_registros_contagens()
returns table (fonte text, recurso text, qtd bigint)
language sql
stable
as $$
  -- Garante as 4 fontes mesmo vazias (recurso NULL, qtd 0); soma-se por fonte
  -- na Edge. Linhas com recurso != null vem do agregado real da view.
  select f.fonte, null::text as recurso, 0::bigint as qtd
  from (values ('effecti'::text), ('nomus'), ('gmail'), ('drive')) as f(fonte)
  where not exists (
    select 1 from public.vw_coleta_registros_mestra v where v.fonte = f.fonte
  )
  union all
  select v.fonte, v.recurso, count(*)::bigint as qtd
  from public.vw_coleta_registros_mestra v
  group by v.fonte, v.recurso
  order by 1, 2;
$$;

comment on function public.coleta_registros_contagens is
  'Contagens da lista mestra da Coleta quebradas por (fonte, recurso). As 4 fontes sempre presentes (recurso NULL/0 quando vazias). A Edge soma por fonte para os chips e expoe por recurso para as pilulas (Nomus = processos + pessoas).';

revoke all on function public.coleta_registros_contagens() from anon, authenticated;
grant execute on function public.coleta_registros_contagens() to service_role;
