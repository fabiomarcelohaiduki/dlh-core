-- =====================================================================
-- Gmail: restaura o ASSUNTO do e-mail como titulo do registro na guia Dados.
--
-- REGRESSAO: a migration 20260629110000 ja fazia o titulo do Gmail derivar do
-- assunto (ref_obtencao ->> 'assunto'). Mas a re-ancoragem da view nos
-- registros-fonte (migration 20260629100000, aplicada DEPOIS em prod) reescreveu
-- o ramo gmail/mensagens derivando o titulo de novo do `rep_nome_anexo` -- isto
-- e, "(corpo).txt" -- perdendo o assunto. Por isso a ultima coleta voltou a
-- mostrar o nome do anexo na coluna "Registro".
--
-- AGORA: o ramo gmail/mensagens volta a derivar titulo (e texto de busca) do
-- assunto, caindo para o nome do anexo e depois para o message_id quando
-- ausente (e-mails antigos sem assunto ate o backfill rodar). O assunto ja e
-- escrito no ref_obtencao por descobrir_vinculos_gmail (Edge gmail-coletar le o
-- header Subject), entao basta a view voltar a le-lo -- nenhum dado novo.
--
-- ADITIVO E SEGURO: `create or replace view` mantendo EXATAMENTE as mesmas
-- colunas (nomes/tipos/ordem) da migration 100000 -- so muda as EXPRESSOES de
-- titulo_curto/busca_texto do ramo Gmail e o agregado interno `rep_assunto`.
-- Nenhuma funcao dependente (coleta_registros_listar / _por_execucao) e afetada,
-- pois consomem a view por nome de coluna. Sem CASCADE.
-- =====================================================================

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
  -- de vinculos (fonte='gmail', registro_origem_id). O titulo legivel e o
  -- ASSUNTO do e-mail (ref_obtencao ->> 'assunto'), identico em corpo e anexos
  -- da mesma mensagem; cai para o nome do anexo e depois para o message_id. ----
  select
    'gmail'::text     as fonte,
    'mensagens'::text as recurso,
    g.registro_origem_id,
    coalesce(nullif(btrim(g.rep_assunto), ''), nullif(btrim(g.rep_nome_anexo), ''), g.registro_origem_id) as titulo_curto,
    lower(coalesce(g.rep_assunto, g.rep_nome_anexo, '')) as busca_texto,
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
      -- Assunto: identico em todos os vinculos da mensagem; max() pega o
      -- nao-nulo independentemente de qual vinculo (corpo/anexo) o carregue.
      max(nullif(btrim(dv.ref_obtencao ->> 'assunto'), '')) as rep_assunto,
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
  'Lista mestra da guia Dados re-ancorada nos registros-fonte: 1 linha por (fonte, recurso, registro_origem_id) via UNION de 5 ramos (effecti/avisos, nomus/processos, nomus/pessoas, gmail/mensagens, drive/arquivos). Gmail = assunto do e-mail (ref_obtencao). documento_vinculos entra como agregado-filho por LEFT JOIN DENTRO de cada ramo (pessoas e zero literal). Lida so via service_role pela Edge coleta-registros.';
