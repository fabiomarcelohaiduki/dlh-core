-- =====================================================================
-- Lista mestra da nova guia "Indexação" (embeddings) da Coleta.
--
-- A guia "Dados" e a "Fila de extração" mostram a COLETA e a EXTRAÇÃO
-- (Tika/OCR). Falta a etapa seguinte: a INDEXAÇÃO (embeddings). A coluna
-- `status_indexacao_agregado` da vw_coleta_registros_mestra é ENGANOSA — ela
-- deriva de documento_vinculos.status_extracao (é status de EXTRAÇÃO, não de
-- embeddings). Por isso a guia Indexação precisa de uma view PRÓPRIA que
-- cruze os status_indexacao REAIS de cada trilha.
--
-- São 4 trilhas independentes de indexação, cada uma com sua coluna
-- status_indexacao:
--   - avisos          (CORPO da licitação Effecti -> aviso_chunks)
--   - nomus_processos (descrição do processo)
--   - nomus_pessoas   (cadastro)
--   - documentos      (ANEXOS extraídos por Tika/OCR, de qualquer fonte)
--
-- Cada REGISTRO combina até duas facetas: o CORPO (só effecti/nomus) e os
-- ANEXOS (documentos via documento_vinculos.documento_id). Gmail/Drive não
-- têm corpo próprio (o próprio e-mail/arquivo entra como anexo).
--
-- A view nasce dos registros-fonte (mesma identidade tripla e keyset da
-- vw_coleta_registros_mestra: fonte/recurso/registro_origem_id, captado_em
-- DESC + id_composto ASC) e agrega:
--   - corpo_status        : status_indexacao do corpo, normalizado.
--   - anexos_*            : contagem dos anexos por situação de indexação.
--   - status_consolidado  : o veredito do registro (precedência abaixo).
--
-- VOCABULÁRIO normalizado (avisos usa 'indexado'; o resto 'concluida'):
--   pendente | em_andamento | concluida | erro  ('indexado' -> 'concluida').
--
-- "Aguardando extração" é HONESTO (não mente "pendente de indexação"):
--   um anexo só pode ser indexado depois de virar texto. Vínculo ainda não
--   extraído (status_extracao pendente/precisa_ocr) conta como aguardando a
--   etapa ANTERIOR, não como pendente de indexação.
--
-- Precedência do status_consolidado (a etapa mais a montante que falta vem
-- primeiro -> aviso ao usuário sobre o que destravar):
--   aguardando_extracao -> erro -> indexando -> pendente -> indexado
--   -> sem_conteudo (nada indexável: sem corpo e sem anexo extraível).
--
-- Roda como owner (postgres, sem RLS); só service_role lê. Idempotente.
-- Aplicar via Node `pg` (SUPABASE_DB_URL), padrão do projeto.
-- =====================================================================

-- ---------------------------------------------------------------------
-- View mestra da indexação. CASCADE defensivo: as funções de página/contagem
-- dependem do rowtype; são recriadas logo abaixo.
-- ---------------------------------------------------------------------
drop view if exists public.vw_indexacao_registros cascade;

create or replace view public.vw_indexacao_registros as
with ramos as (
  -- ----- effecti/avisos: corpo = avisos.status_indexacao; anexos via dv -----
  select
    'effecti'::text as fonte,
    'avisos'::text  as recurso,
    av.effecti_id   as registro_origem_id,
    coalesce(nullif(btrim(av.objeto), ''), av.effecti_id) as titulo_curto,
    lower(coalesce(av.objeto, '') || ' ' || coalesce(av.orgao, '')) as busca_texto,
    av.data_captura as captado_em,
    -- Corpo normalizado ('indexado' -> 'concluida'). Aviso SEMPRE tem corpo.
    case when av.status_indexacao = 'indexado' then 'concluida' else av.status_indexacao end as corpo_status,
    -- Anexos extraídos (têm documento) que são indexáveis.
    count(d.id) as anexos_indexavel,
    count(*) filter (where d.status_indexacao = 'concluida')     as anexos_indexados,
    count(*) filter (where d.status_indexacao = 'pendente')      as anexos_pendente,
    count(*) filter (where d.status_indexacao = 'em_andamento')  as anexos_andamento,
    count(*) filter (where d.status_indexacao = 'erro')          as anexos_erro,
    -- Anexos ainda não extraídos (vão virar texto): aguardam a etapa anterior.
    count(dv.id) filter (where dv.status_extracao in ('pendente', 'precisa_ocr')) as anexos_aguardando,
    (array_agg(dv.id order by dv.id) filter (where dv.id is not null))[1]            as rep_id,
    (array_agg(dv.nome_anexo order by dv.id) filter (where dv.id is not null))[1]    as rep_nome_anexo,
    (array_agg(dv.documento_id order by dv.id) filter (where dv.id is not null))[1]  as rep_documento_id
  from public.avisos av
  left join public.documento_vinculos dv
    on dv.fonte = 'effecti' and dv.registro_origem_id = av.effecti_id
  left join public.documentos d
    on d.id = dv.documento_id
  group by av.effecti_id, av.objeto, av.orgao, av.data_captura, av.status_indexacao

  union all

  -- ----- nomus/processos: corpo = nomus_processos.status_indexacao; anexos --
  select
    'nomus'::text     as fonte,
    'processos'::text as recurso,
    np.nomus_id       as registro_origem_id,
    np.nomus_id       as titulo_curto,
    lower(np.nomus_id || ' ' || coalesce(np.pessoa, '')) as busca_texto,
    np.created_at     as captado_em,
    np.status_indexacao as corpo_status,
    count(d.id) as anexos_indexavel,
    count(*) filter (where d.status_indexacao = 'concluida')     as anexos_indexados,
    count(*) filter (where d.status_indexacao = 'pendente')      as anexos_pendente,
    count(*) filter (where d.status_indexacao = 'em_andamento')  as anexos_andamento,
    count(*) filter (where d.status_indexacao = 'erro')          as anexos_erro,
    count(dv.id) filter (where dv.status_extracao in ('pendente', 'precisa_ocr')) as anexos_aguardando,
    (array_agg(dv.id order by dv.id) filter (where dv.id is not null))[1]            as rep_id,
    (array_agg(dv.nome_anexo order by dv.id) filter (where dv.id is not null))[1]    as rep_nome_anexo,
    (array_agg(dv.documento_id order by dv.id) filter (where dv.id is not null))[1]  as rep_documento_id
  from public.nomus_processos np
  left join public.documento_vinculos dv
    on dv.fonte = 'nomus' and dv.registro_origem_id = np.nomus_id
  left join public.documentos d
    on d.id = dv.documento_id
  group by np.nomus_id, np.pessoa, np.created_at, np.status_indexacao

  union all

  -- ----- nomus/pessoas: só corpo (cadastro); nunca tem anexo (E1: zero
  -- literal, sem join, para não herdar vínculos de processos). ----
  select
    'nomus'::text   as fonte,
    'pessoas'::text as recurso,
    p.nomus_id      as registro_origem_id,
    coalesce(nullif(p.nome, ''), nullif(p.nome_razao_social, ''), p.nomus_id) as titulo_curto,
    lower(concat_ws(' ',
      p.nome, p.nome_razao_social, p.cnpj, p.codigo, p.nomus_id, p.email, p.municipio
    )) as busca_texto,
    p.created_at    as captado_em,
    p.status_indexacao as corpo_status,
    0::bigint as anexos_indexavel,
    0::bigint as anexos_indexados,
    0::bigint as anexos_pendente,
    0::bigint as anexos_andamento,
    0::bigint as anexos_erro,
    0::bigint as anexos_aguardando,
    null::uuid as rep_id,
    null::text as rep_nome_anexo,
    null::uuid as rep_documento_id
  from public.nomus_pessoas p

  union all

  -- ----- gmail/mensagens: sem corpo próprio (o e-mail entra como anexo). ----
  select
    'gmail'::text     as fonte,
    'mensagens'::text as recurso,
    g.registro_origem_id,
    coalesce(nullif(btrim(g.rep_nome_anexo), ''), g.registro_origem_id) as titulo_curto,
    lower(coalesce(g.rep_nome_anexo, '')) as busca_texto,
    g.captado_em,
    null::text as corpo_status,
    g.anexos_indexavel,
    g.anexos_indexados,
    g.anexos_pendente,
    g.anexos_andamento,
    g.anexos_erro,
    g.anexos_aguardando,
    g.rep_id,
    g.rep_nome_anexo,
    g.rep_documento_id
  from (
    select
      dv.registro_origem_id,
      min(dv.created_at) as captado_em,
      count(d.id) as anexos_indexavel,
      count(*) filter (where d.status_indexacao = 'concluida')     as anexos_indexados,
      count(*) filter (where d.status_indexacao = 'pendente')      as anexos_pendente,
      count(*) filter (where d.status_indexacao = 'em_andamento')  as anexos_andamento,
      count(*) filter (where d.status_indexacao = 'erro')          as anexos_erro,
      count(dv.id) filter (where dv.status_extracao in ('pendente', 'precisa_ocr')) as anexos_aguardando,
      (array_agg(dv.id order by dv.id) filter (where dv.id is not null))[1]            as rep_id,
      (array_agg(dv.nome_anexo order by dv.id) filter (where dv.id is not null))[1]    as rep_nome_anexo,
      (array_agg(dv.documento_id order by dv.id) filter (where dv.id is not null))[1]  as rep_documento_id
    from public.documento_vinculos dv
    left join public.documentos d on d.id = dv.documento_id
    where dv.fonte = 'gmail'
    group by dv.registro_origem_id
  ) g

  union all

  -- ----- drive/arquivos: idem gmail. ----
  select
    'drive'::text    as fonte,
    'arquivos'::text as recurso,
    dr.registro_origem_id,
    coalesce(nullif(btrim(dr.rep_nome_anexo), ''), dr.registro_origem_id) as titulo_curto,
    lower(coalesce(dr.rep_nome_anexo, '')) as busca_texto,
    dr.captado_em,
    null::text as corpo_status,
    dr.anexos_indexavel,
    dr.anexos_indexados,
    dr.anexos_pendente,
    dr.anexos_andamento,
    dr.anexos_erro,
    dr.anexos_aguardando,
    dr.rep_id,
    dr.rep_nome_anexo,
    dr.rep_documento_id
  from (
    select
      dv.registro_origem_id,
      min(dv.created_at) as captado_em,
      count(d.id) as anexos_indexavel,
      count(*) filter (where d.status_indexacao = 'concluida')     as anexos_indexados,
      count(*) filter (where d.status_indexacao = 'pendente')      as anexos_pendente,
      count(*) filter (where d.status_indexacao = 'em_andamento')  as anexos_andamento,
      count(*) filter (where d.status_indexacao = 'erro')          as anexos_erro,
      count(dv.id) filter (where dv.status_extracao in ('pendente', 'precisa_ocr')) as anexos_aguardando,
      (array_agg(dv.id order by dv.id) filter (where dv.id is not null))[1]            as rep_id,
      (array_agg(dv.nome_anexo order by dv.id) filter (where dv.id is not null))[1]    as rep_nome_anexo,
      (array_agg(dv.documento_id order by dv.id) filter (where dv.id is not null))[1]  as rep_documento_id
    from public.documento_vinculos dv
    left join public.documentos d on d.id = dv.documento_id
    where dv.fonte = 'drive'
    group by dv.registro_origem_id
  ) dr
)
select
  r.fonte,
  r.recurso,
  r.registro_origem_id,
  r.fonte || ':' || r.recurso || ':' || r.registro_origem_id as id_composto,
  r.titulo_curto,
  r.busca_texto,
  r.captado_em,
  r.corpo_status,
  r.anexos_indexavel,
  r.anexos_indexados,
  r.anexos_pendente,
  r.anexos_andamento,
  r.anexos_erro,
  r.anexos_aguardando,
  r.rep_id,
  r.rep_nome_anexo,
  r.rep_documento_id,
  -- Veredito do registro. Etapa mais a montante que falta vem primeiro.
  -- Indexável total = (corpo presente ? 1 : 0) + anexos_indexavel; quando 0 e
  -- nada aguardando, é 'sem_conteudo' (ex.: registro com todos os vínculos
  -- inobtevíveis/ignorados e sem corpo).
  case
    when r.anexos_aguardando > 0 then 'aguardando_extracao'
    when r.corpo_status = 'erro' or r.anexos_erro > 0 then 'erro'
    when r.corpo_status = 'em_andamento' or r.anexos_andamento > 0 then 'indexando'
    when r.corpo_status = 'pendente' or r.anexos_pendente > 0 then 'pendente'
    when r.corpo_status = 'concluida' or r.anexos_indexados > 0 then 'indexado'
    else 'sem_conteudo'
  end as status_consolidado
from ramos r;

comment on view public.vw_indexacao_registros is
  'Lista mestra da guia Indexação (embeddings): 1 linha por (fonte, recurso, registro_origem_id) com o status de indexação consolidado de cada registro. Cruza o CORPO (avisos/nomus_*.status_indexacao, normalizado: indexado->concluida) com os ANEXOS (documentos.status_indexacao via documento_vinculos.documento_id) e expõe anexos_aguardando (vínculos ainda não extraídos). Mesma identidade/keyset da vw_coleta_registros_mestra. Lida só via service_role.';

-- ---------------------------------------------------------------------
-- Página por keyset (captado_em DESC, id_composto ASC). Filtros
-- fonte/recurso/status (status_consolidado) e busca (ilike escapado, 200
-- chars) em SQL; clamp [1,200]. Espelha coleta_registros_listar.
-- ---------------------------------------------------------------------
create or replace function public.indexacao_registros_listar(
  p_fonte text default null,
  p_recurso text default null,
  p_status text default null,
  p_busca text default null,
  p_cursor_captado_em timestamptz default null,
  p_cursor_id_composto text default null,
  p_limit integer default 50
)
returns setof public.vw_indexacao_registros
language sql
stable
as $$
  select *
  from public.vw_indexacao_registros v
  where (p_fonte is null or v.fonte = p_fonte)
    and (p_recurso is null or v.recurso = p_recurso)
    and (p_status is null or v.status_consolidado = p_status)
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

comment on function public.indexacao_registros_listar is
  'Uma página (keyset captado_em DESC, id_composto ASC) da lista mestra de indexação. Filtros fonte/recurso/status (status_consolidado) e busca (ilike escapado, 200 chars) em SQL; clamp [1,200]. Chamada pela Edge indexacao via service_role.';

revoke all on function public.indexacao_registros_listar(text, text, text, text, timestamptz, text, integer) from anon, authenticated;
grant execute on function public.indexacao_registros_listar(text, text, text, text, timestamptz, text, integer) to service_role;

-- ---------------------------------------------------------------------
-- Contagens por (fonte, recurso, status_consolidado): alimenta os chips de
-- fonte (somando recursos na Edge), as pílulas de recurso e os cards de
-- status. As 4 fontes sempre presentes (left join sobre a lista fixa) para
-- os chips não sumirem quando uma fonte está vazia.
-- ---------------------------------------------------------------------
create or replace function public.indexacao_registros_contagens()
returns table (fonte text, recurso text, status text, qtd bigint)
language sql
stable
as $$
  select f.fonte, null::text as recurso, null::text as status, 0::bigint as qtd
  from (values ('effecti'::text), ('nomus'), ('gmail'), ('drive')) as f(fonte)
  where not exists (
    select 1 from public.vw_indexacao_registros v where v.fonte = f.fonte
  )
  union all
  select v.fonte, v.recurso, v.status_consolidado, count(*)::bigint as qtd
  from public.vw_indexacao_registros v
  group by v.fonte, v.recurso, v.status_consolidado
  order by 1, 2, 3;
$$;

comment on function public.indexacao_registros_contagens is
  'Contagens da lista mestra de indexação por (fonte, recurso, status_consolidado). As 4 fontes sempre presentes (linha NULL/0 quando vazias). A Edge soma por fonte (chips), por recurso (pílulas) e por status (cards).';

revoke all on function public.indexacao_registros_contagens() from anon, authenticated;
grant execute on function public.indexacao_registros_contagens() to service_role;

-- ---------------------------------------------------------------------
-- Só o service_role (Edge) enxerga a view.
-- ---------------------------------------------------------------------
revoke all on public.vw_indexacao_registros from anon, authenticated;
grant select on public.vw_indexacao_registros to service_role;
