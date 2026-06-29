-- =====================================================================
-- Lista mestra da guia "Dados" da Coleta movida para o Postgres,
-- RE-ANCORADA nos registros-fonte (D1).
--
-- A versao anterior ancorava a view em documento_vinculos: so aparecia
-- registro que JA tinha anexo. Registros-fonte sem nenhum vinculo (aviso
-- sem edital baixado, processo Nomus sem anexo, pessoa Nomus — que nunca
-- tem anexo) ficavam invisiveis na lista mestra.
--
-- Agora a view nasce dos registros-fonte e trata documento_vinculos como
-- agregado-FILHO via LEFT JOIN. Sao 5 ramos unidos por UNION ALL:
--   - effecti/avisos     : 1 linha por avisos.effecti_id        (com anexos)
--   - nomus/processos     : 1 linha por nomus_processos.nomus_id  (com anexos)
--   - nomus/pessoas       : 1 linha por nomus_pessoas.nomus_id    (ZERO literal)
--   - gmail/mensagens     : distinct (registro_origem_id) de documento_vinculos
--   - drive/arquivos      : distinct (registro_origem_id) de documento_vinculos
--
-- Risco critico E1 (cross-attribution): nomus/processos e nomus/pessoas
-- compartilham fonte='nomus' e nomus_id, e documento_vinculos NAO tem coluna
-- `recurso`. Por isso o LEFT JOIN do agregado e feito DENTRO de cada ramo
-- (nunca por um agregado global): o ramo processos junta os vinculos nomus
-- (que sao efetivamente de processos) e o ramo pessoas e ZERO literal — sem
-- join — logo nunca herda vinculos de processos.
--
-- O contrato de colunas da view e o keyset (captado_em DESC, id_composto ASC)
-- sao preservados; acrescenta-se a coluna `recurso`. As funcoes de pagina e
-- de contagem continuam consumindo a view via service_role; o contrato HTTP
-- da Edge nao muda.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Indices de suporte ao captado_em derivado por origem. A ordenacao/keyset
-- da lista mestra e por captado_em, que em cada ramo-fonte mapeia para uma
-- coluna fisica da tabela-fonte (avisos.data_captura, *_processos.created_at,
-- *_pessoas.created_at). Para gmail/drive o captado_em sai de
-- min(documento_vinculos.created_at), ja apoiado por
-- idx_documento_vinculos_fonte_registro.
-- ---------------------------------------------------------------------
create index if not exists idx_avisos_data_captura
  on public.avisos (data_captura);

create index if not exists idx_nomus_processos_created_at
  on public.nomus_processos (created_at);

create index if not exists idx_nomus_pessoas_created_at
  on public.nomus_pessoas (created_at);

-- ---------------------------------------------------------------------
-- View mestra re-ancorada nos registros-fonte. Roda como owner (postgres),
-- enxergando as tabelas sem RLS; so service_role pode le-la.
--
-- DROP CASCADE defensivo: a coluna `recurso` foi adicionada e a ordem das
-- colunas mudou, o que `create or replace view` nao permite sobre uma view
-- pre-existente. O CASCADE derruba as funcoes que dependem do rowtype da
-- view; ambas sao recriadas logo abaixo no mesmo arquivo.
-- ---------------------------------------------------------------------
drop view if exists public.vw_coleta_registros_mestra cascade;

create or replace view public.vw_coleta_registros_mestra as
with ramos as (
  -- ----- Ramo effecti/avisos: aviso e a fonte, anexos via LEFT JOIN -----
  select
    'effecti'::text as fonte,
    'avisos'::text  as recurso,
    av.effecti_id   as registro_origem_id,
    coalesce(nullif(btrim(av.objeto), ''), av.effecti_id) as titulo_curto,
    lower(coalesce(av.objeto, '') || ' ' || coalesce(av.orgao, '')) as busca_texto,
    av.data_captura as captado_em,
    count(dv.id) as qtd_documentos,
    count(dv.id) filter (where dv.status_extracao in ('pendente', 'precisa_ocr')) as qtd_pendentes,
    count(dv.id) filter (where dv.status_extracao in ('erro', 'inobtenivel')) as qtd_erros,
    count(dv.id) filter (where dv.status_extracao = 'ignorado') as qtd_ignorado,
    bool_or(dv.status_extracao in ('pendente', 'precisa_ocr')) as has_pendente,
    bool_or(dv.status_extracao in ('extraido', 'herdado')) as has_extraido,
    bool_or(dv.status_extracao in ('erro', 'inobtenivel')) as has_erro,
    (array_agg(dv.id order by dv.id))[1] as rep_id,
    (array_agg(dv.nome_anexo order by dv.id))[1] as rep_nome_anexo,
    (array_agg(dv.documento_id order by dv.id))[1] as rep_documento_id
  from public.avisos av
  left join public.documento_vinculos dv
    on dv.fonte = 'effecti' and dv.registro_origem_id = av.effecti_id
  group by av.effecti_id, av.objeto, av.orgao, av.data_captura

  union all

  -- ----- Ramo nomus/processos: processo e a fonte, anexos via LEFT JOIN
  -- (processos EFETIVAMENTE geram documento_vinculos com fonte='nomus'). ----
  select
    'nomus'::text     as fonte,
    'processos'::text as recurso,
    np.nomus_id       as registro_origem_id,
    np.nomus_id       as titulo_curto,
    lower(np.nomus_id || ' ' || coalesce(np.pessoa, '')) as busca_texto,
    np.created_at     as captado_em,
    count(dv.id) as qtd_documentos,
    count(dv.id) filter (where dv.status_extracao in ('pendente', 'precisa_ocr')) as qtd_pendentes,
    count(dv.id) filter (where dv.status_extracao in ('erro', 'inobtenivel')) as qtd_erros,
    count(dv.id) filter (where dv.status_extracao = 'ignorado') as qtd_ignorado,
    bool_or(dv.status_extracao in ('pendente', 'precisa_ocr')) as has_pendente,
    bool_or(dv.status_extracao in ('extraido', 'herdado')) as has_extraido,
    bool_or(dv.status_extracao in ('erro', 'inobtenivel')) as has_erro,
    (array_agg(dv.id order by dv.id))[1] as rep_id,
    (array_agg(dv.nome_anexo order by dv.id))[1] as rep_nome_anexo,
    (array_agg(dv.documento_id order by dv.id))[1] as rep_documento_id
  from public.nomus_processos np
  left join public.documento_vinculos dv
    on dv.fonte = 'nomus' and dv.registro_origem_id = np.nomus_id
  group by np.nomus_id, np.pessoa, np.created_at

  union all

  -- ----- Ramo nomus/pessoas: ZERO literal. Pessoas Nomus nunca geram
  -- anexo; o ramo NAO faz LEFT JOIN para nao herdar vinculos de processos
  -- (mesmo fonte='nomus' + nomus_id => risco E1 de cross-attribution). ----
  select
    'nomus'::text   as fonte,
    'pessoas'::text as recurso,
    p.nomus_id      as registro_origem_id,
    coalesce(nullif(p.nome, ''), nullif(p.nome_razao_social, ''), p.nomus_id) as titulo_curto,
    lower(concat_ws(' ',
      p.nome, p.nome_razao_social, p.cnpj, p.codigo, p.nomus_id, p.email, p.municipio
    )) as busca_texto,
    p.created_at    as captado_em,
    0::bigint as qtd_documentos,
    0::bigint as qtd_pendentes,
    0::bigint as qtd_erros,
    0::bigint as qtd_ignorado,
    null::boolean as has_pendente,
    null::boolean as has_extraido,
    null::boolean as has_erro,
    null::uuid as rep_id,
    null::text as rep_nome_anexo,
    null::uuid as rep_documento_id
  from public.nomus_pessoas p

  union all

  -- ----- Ramo gmail/mensagens: a propria mensagem so existe como conjunto
  -- de vinculos (fonte='gmail', registro_origem_id). ----
  select
    'gmail'::text     as fonte,
    'mensagens'::text as recurso,
    g.registro_origem_id,
    coalesce(nullif(btrim(g.rep_nome_anexo), ''), g.registro_origem_id) as titulo_curto,
    lower(coalesce(g.rep_nome_anexo, '')) as busca_texto,
    g.captado_em,
    g.qtd_documentos,
    g.qtd_pendentes,
    g.qtd_erros,
    g.qtd_ignorado,
    g.has_pendente,
    g.has_extraido,
    g.has_erro,
    g.rep_id,
    g.rep_nome_anexo,
    g.rep_documento_id
  from (
    select
      dv.registro_origem_id,
      min(dv.created_at) as captado_em,
      count(dv.id) as qtd_documentos,
      count(dv.id) filter (where dv.status_extracao in ('pendente', 'precisa_ocr')) as qtd_pendentes,
      count(dv.id) filter (where dv.status_extracao in ('erro', 'inobtenivel')) as qtd_erros,
      count(dv.id) filter (where dv.status_extracao = 'ignorado') as qtd_ignorado,
      bool_or(dv.status_extracao in ('pendente', 'precisa_ocr')) as has_pendente,
      bool_or(dv.status_extracao in ('extraido', 'herdado')) as has_extraido,
      bool_or(dv.status_extracao in ('erro', 'inobtenivel')) as has_erro,
      (array_agg(dv.id order by dv.id))[1] as rep_id,
      (array_agg(dv.nome_anexo order by dv.id))[1] as rep_nome_anexo,
      (array_agg(dv.documento_id order by dv.id))[1] as rep_documento_id
    from public.documento_vinculos dv
    where dv.fonte = 'gmail'
    group by dv.registro_origem_id
  ) g

  union all

  -- ----- Ramo drive/arquivos: idem gmail, vinculos com fonte='drive'. ----
  select
    'drive'::text    as fonte,
    'arquivos'::text as recurso,
    d.registro_origem_id,
    coalesce(nullif(btrim(d.rep_nome_anexo), ''), d.registro_origem_id) as titulo_curto,
    lower(coalesce(d.rep_nome_anexo, '')) as busca_texto,
    d.captado_em,
    d.qtd_documentos,
    d.qtd_pendentes,
    d.qtd_erros,
    d.qtd_ignorado,
    d.has_pendente,
    d.has_extraido,
    d.has_erro,
    d.rep_id,
    d.rep_nome_anexo,
    d.rep_documento_id
  from (
    select
      dv.registro_origem_id,
      min(dv.created_at) as captado_em,
      count(dv.id) as qtd_documentos,
      count(dv.id) filter (where dv.status_extracao in ('pendente', 'precisa_ocr')) as qtd_pendentes,
      count(dv.id) filter (where dv.status_extracao in ('erro', 'inobtenivel')) as qtd_erros,
      count(dv.id) filter (where dv.status_extracao = 'ignorado') as qtd_ignorado,
      bool_or(dv.status_extracao in ('pendente', 'precisa_ocr')) as has_pendente,
      bool_or(dv.status_extracao in ('extraido', 'herdado')) as has_extraido,
      bool_or(dv.status_extracao in ('erro', 'inobtenivel')) as has_erro,
      (array_agg(dv.id order by dv.id))[1] as rep_id,
      (array_agg(dv.nome_anexo order by dv.id))[1] as rep_nome_anexo,
      (array_agg(dv.documento_id order by dv.id))[1] as rep_documento_id
    from public.documento_vinculos dv
    where dv.fonte = 'drive'
    group by dv.registro_origem_id
  ) d
)
select
  r.fonte,
  r.recurso,
  r.registro_origem_id,
  r.fonte || ':' || r.recurso || ':' || r.registro_origem_id as id_composto,
  r.titulo_curto,
  r.busca_texto,
  r.captado_em,
  r.qtd_documentos,
  r.qtd_pendentes,
  r.qtd_erros,
  r.qtd_ignorado,
  r.rep_id,
  r.rep_nome_anexo,
  r.rep_documento_id,
  -- Precedencia deterministica (SPEC 4.5.4) com sem_documentos PRIMEIRO:
  -- num LEFT JOIN sem match os has_* viram NULL (nao false), entao precisa
  -- vir antes para nao escorregar para 'pendente'.
  case
    when r.qtd_documentos = 0 then 'sem_documentos'
    when r.has_pendente then 'em_andamento'
    when r.has_extraido and not r.has_erro then 'concluida'
    when r.has_erro and not r.has_extraido then 'erro'
    when r.has_extraido and r.has_erro then 'mista'
    else 'pendente'
  end as status_indexacao_agregado
from ramos r;

comment on view public.vw_coleta_registros_mestra is
  'Lista mestra da guia Dados re-ancorada nos registros-fonte: 1 linha por (fonte, recurso, registro_origem_id) via UNION de 5 ramos (effecti/avisos, nomus/processos, nomus/pessoas, gmail/mensagens, drive/arquivos). documento_vinculos entra como agregado-filho por LEFT JOIN DENTRO de cada ramo (pessoas e zero literal). Lida so via service_role pela Edge coleta-registros.';

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
