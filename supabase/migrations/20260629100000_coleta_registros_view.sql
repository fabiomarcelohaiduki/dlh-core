-- =====================================================================
-- Lista mestra da guia "Dados" da Coleta movida para o Postgres.
--
-- Antes, a Edge `coleta-registros` lia TODAS as linhas de documento_vinculos
-- (~54k) por PostgREST para o Deno, agregava por (fonte, registro_origem_id)
-- em JS, cruzava todos os avisos/nomus, ordenava ~34k grupos e fatiava 25 — a
-- cada request, repetido pelo poll de 5s. Custo proporcional ao acervo inteiro
-- em toda abertura da guia.
--
-- Esta migration empurra a agregacao para o banco (apoiada no indice
-- idx_documento_vinculos_fonte_registro), expondo:
--   - vw_coleta_registros_mestra: 1 linha por (fonte, registro_origem_id) com
--     contagens, status agregado (precedencia SPEC 4.5.4), captado_em derivado
--     (Effecti = avisos.data_captura; demais = min(created_at) do vinculo),
--     titulo_curto, o vinculo representativo (rep_*) e busca_texto;
--   - coleta_registros_listar(...): UMA pagina por keyset (captado_em DESC,
--     id_composto ASC), com os filtros fonte/status/tem_erro/busca em SQL;
--   - coleta_registros_contagens(): total por fonte (cumulativo, sem filtro),
--     para os chips da toolbar.
--
-- A Edge passa a ler so a pagina (25 linhas) + as contagens, e enriquece
-- cabecalho/link apenas dos itens da pagina. O contrato HTTP nao muda.
-- =====================================================================

-- ---------------------------------------------------------------------
-- View mestra: agregacao por registro + derivacoes (status, captado_em,
-- titulo, representativo, texto de busca). Roda como owner (postgres),
-- enxergando documento_vinculos sem RLS; so service_role pode le-la.
-- ---------------------------------------------------------------------
create or replace view public.vw_coleta_registros_mestra as
with agg as (
  select
    dv.fonte,
    dv.registro_origem_id,
    count(*) as qtd_documentos,
    count(*) filter (where dv.status_extracao in ('pendente', 'precisa_ocr')) as qtd_pendentes,
    count(*) filter (where dv.status_extracao in ('erro', 'inobtenivel')) as qtd_erros,
    count(*) filter (where dv.status_extracao = 'ignorado') as qtd_ignorado,
    bool_or(dv.status_extracao in ('pendente', 'precisa_ocr')) as has_pendente,
    bool_or(dv.status_extracao in ('extraido', 'herdado')) as has_extraido,
    bool_or(dv.status_extracao in ('erro', 'inobtenivel')) as has_erro
  from public.documento_vinculos dv
  where dv.fonte in ('effecti', 'nomus', 'drive', 'gmail')
  group by dv.fonte, dv.registro_origem_id
),
-- Vinculo representativo: menor created_at, desempate por id. Origem do
-- cabecalho Gmail/Drive (nome_anexo) e do captado_em das fontes nao-Effecti.
rep as (
  select distinct on (dv.fonte, dv.registro_origem_id)
    dv.fonte,
    dv.registro_origem_id,
    dv.id as rep_id,
    dv.nome_anexo as rep_nome_anexo,
    dv.documento_id as rep_documento_id,
    dv.created_at as rep_created_at
  from public.documento_vinculos dv
  where dv.fonte in ('effecti', 'nomus', 'drive', 'gmail')
  order by dv.fonte, dv.registro_origem_id, dv.created_at asc, dv.id asc
)
select
  a.fonte || ':' || a.registro_origem_id as id_composto,
  a.fonte,
  a.registro_origem_id,
  case
    when a.fonte = 'effecti' then coalesce(av.data_captura, r.rep_created_at)
    else r.rep_created_at
  end as captado_em,
  a.qtd_documentos,
  a.qtd_pendentes,
  a.qtd_erros,
  a.qtd_ignorado,
  -- Precedencia deterministica (SPEC 4.5.4).
  case
    when a.has_pendente then 'em_andamento'
    when a.has_extraido and not a.has_erro then 'concluida'
    when a.has_erro and not a.has_extraido then 'erro'
    when a.has_extraido and a.has_erro then 'mista'
    else 'pendente'
  end as status_indexacao_agregado,
  -- Effecti = objeto (fallback id); Nomus = id; Gmail/Drive = nome do anexo.
  case
    when a.fonte = 'effecti' then coalesce(nullif(btrim(av.objeto), ''), a.registro_origem_id)
    when a.fonte = 'nomus' then a.registro_origem_id
    else coalesce(nullif(btrim(r.rep_nome_anexo), ''), a.registro_origem_id)
  end as titulo_curto,
  r.rep_id,
  r.rep_nome_anexo,
  r.rep_documento_id,
  -- Texto unico para a busca server-side (case-insensitive, ja lowercased).
  case
    when a.fonte = 'effecti' then lower(coalesce(av.objeto, '') || ' ' || coalesce(av.orgao, ''))
    when a.fonte = 'nomus' then lower(a.registro_origem_id || ' ' || coalesce(np.pessoa, ''))
    else lower(coalesce(r.rep_nome_anexo, ''))
  end as busca_texto
from agg a
join rep r on r.fonte = a.fonte and r.registro_origem_id = a.registro_origem_id
left join public.avisos av on a.fonte = 'effecti' and av.effecti_id = a.registro_origem_id
left join public.nomus_processos np on a.fonte = 'nomus' and np.nomus_id = a.registro_origem_id;

comment on view public.vw_coleta_registros_mestra is
  'Lista mestra da guia Dados: 1 linha por (fonte, registro_origem_id) com contagens, status agregado, captado_em derivado, titulo e vinculo representativo. Lida so via service_role pela Edge coleta-registros.';

-- ---------------------------------------------------------------------
-- Pagina por keyset: captado_em DESC, id_composto ASC. O cursor carrega o
-- captado_em (timestamptz, precisao plena) e o id_composto da ultima linha.
-- Filtros fonte/status/tem_erro/busca aplicados em SQL.
-- ---------------------------------------------------------------------
create or replace function public.coleta_registros_listar(
  p_fonte text default null,
  p_status text default null,
  p_tem_erro boolean default false,
  p_busca text default null,
  p_cursor_captado timestamptz default null,
  p_cursor_id text default null,
  p_limit integer default 25
)
returns setof public.vw_coleta_registros_mestra
language sql
stable
as $$
  select *
  from public.vw_coleta_registros_mestra v
  where (p_fonte is null or v.fonte = p_fonte)
    and (p_status is null or v.status_indexacao_agregado = p_status)
    and (not p_tem_erro or v.qtd_erros > 0)
    and (p_busca is null or v.busca_texto like '%' || lower(p_busca) || '%')
    and (
      p_cursor_captado is null
      or v.captado_em < p_cursor_captado
      or (v.captado_em = p_cursor_captado and v.id_composto > p_cursor_id)
    )
  order by v.captado_em desc, v.id_composto asc
  limit greatest(1, least(p_limit, 200));
$$;

comment on function public.coleta_registros_listar is
  'Uma pagina (keyset captado_em DESC, id_composto ASC) da lista mestra da Coleta, com filtros fonte/status/tem_erro/busca em SQL. Chamada pela Edge coleta-registros via service_role.';

-- ---------------------------------------------------------------------
-- Contagens por fonte (cumulativas, independentes de filtro/paginacao).
-- ---------------------------------------------------------------------
create or replace function public.coleta_registros_contagens()
returns table (fonte text, total bigint)
language sql
stable
as $$
  select v.fonte, count(*)::bigint as total
  from public.vw_coleta_registros_mestra v
  group by v.fonte;
$$;

comment on function public.coleta_registros_contagens is
  'Total de registros mestres por fonte (cumulativo, sem filtros) para os chips da toolbar da guia Dados.';

-- ---------------------------------------------------------------------
-- So o service_role (usado pela Edge) enxerga a view e as funcoes; anon e
-- authenticated nao tem acesso direto a esse agregado.
-- ---------------------------------------------------------------------
revoke all on public.vw_coleta_registros_mestra from anon, authenticated;
grant select on public.vw_coleta_registros_mestra to service_role;

revoke all on function public.coleta_registros_listar(text, text, boolean, text, timestamptz, text, integer) from anon, authenticated;
grant execute on function public.coleta_registros_listar(text, text, boolean, text, timestamptz, text, integer) to service_role;

revoke all on function public.coleta_registros_contagens() from anon, authenticated;
grant execute on function public.coleta_registros_contagens() to service_role;
