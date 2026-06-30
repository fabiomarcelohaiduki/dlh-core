-- =====================================================================
-- Fix do título do registro Gmail na guia "Indexação".
--
-- A vw_indexacao_registros derivava o `titulo_curto` do ramo Gmail do NOME DO
-- ANEXO representativo (rep_nome_anexo) — que, no Gmail, costuma ser o corpo do
-- e-mail importado como "(corpo).txt". Resultado: a coluna Registro mostrava
-- "(corpo).txt" em vez do ASSUNTO do e-mail.
--
-- A guia "Dados" (vw_coleta_registros_mestra) já resolve isso: deriva o título
-- do assunto gravado em documento_vinculos.ref_obtencao->>'assunto'. Esta
-- migration espelha aquele tratamento no ramo Gmail da view de indexação:
-- agrega o assunto (rep_assunto) e o usa como título, caindo para o nome do
-- anexo e depois para o registro_origem_id (e-mails antigos sem assunto no
-- dado até a re-coleta). Drive segue pelo nome do arquivo (não tem assunto).
--
-- As colunas de saída (nomes/tipos/ordem) são IDÊNTICAS às da view anterior —
-- só muda a EXPRESSÃO que alimenta titulo_curto/busca_texto do ramo Gmail —,
-- então `create or replace view` basta (não derruba as funções dependentes).
-- Idempotente. Aplicar via Node `pg` (SUPABASE_DB_URL), padrão do projeto.
-- =====================================================================

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
    case when av.status_indexacao = 'indexado' then 'concluida' else av.status_indexacao end as corpo_status,
    count(d.id) as anexos_indexavel,
    count(*) filter (where d.status_indexacao = 'concluida')     as anexos_indexados,
    count(*) filter (where d.status_indexacao = 'pendente')      as anexos_pendente,
    count(*) filter (where d.status_indexacao = 'em_andamento')  as anexos_andamento,
    count(*) filter (where d.status_indexacao = 'erro')          as anexos_erro,
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

  -- ----- gmail/mensagens: sem corpo próprio (o e-mail entra como anexo). O
  -- título é o ASSUNTO do e-mail (ref_obtencao->>'assunto'), igual à guia
  -- Dados; cai para o nome do anexo e depois o id quando ausente. ----
  select
    'gmail'::text     as fonte,
    'mensagens'::text as recurso,
    g.registro_origem_id,
    coalesce(nullif(btrim(g.rep_assunto), ''), nullif(btrim(g.rep_nome_anexo), ''), g.registro_origem_id) as titulo_curto,
    lower(coalesce(g.rep_assunto, g.rep_nome_anexo, '')) as busca_texto,
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
      max(nullif(btrim(dv.ref_obtencao ->> 'assunto'), '')) as rep_assunto,
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

  -- ----- drive/arquivos: idem gmail, mas título = nome do arquivo. ----
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
  'Lista mestra da guia Indexação (embeddings): 1 linha por (fonte, recurso, registro_origem_id) com o status de indexação consolidado de cada registro. Cruza o CORPO (avisos/nomus_*.status_indexacao, normalizado: indexado->concluida) com os ANEXOS (documentos.status_indexacao via documento_vinculos.documento_id) e expõe anexos_aguardando (vínculos ainda não extraídos). Gmail = assunto do e-mail (ref_obtencao->>''assunto''). Mesma identidade/keyset da vw_coleta_registros_mestra. Lida só via service_role.';
