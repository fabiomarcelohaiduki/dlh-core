-- =====================================================================
-- Gmail: assunto do e-mail como titulo do registro na guia Dados.
--
-- ANTES: a coluna "Registro" da guia Dados mostrava, para o Gmail, o nome
-- tecnico do vinculo de corpo -- "(corpo).txt" -- porque a view derivava o
-- titulo do `nome_anexo`. O assunto do e-mail nunca era capturado.
--
-- AGORA: a Edge gmail-coletar le o header Subject e propaga `assunto` em cada
-- item; esta migration faz duas coisas ADITIVAS:
--   1. descobrir_vinculos_gmail passa a gravar `assunto` dentro do ref_obtencao
--      (jsonb que ja carrega os metadados da mensagem -- thread_id, tipo, nome).
--   2. vw_coleta_registros_mestra deriva o titulo (e o texto de busca) do
--      Gmail a partir desse assunto, caindo para o nome do anexo e depois para
--      o id quando ausente (e-mails antigos sem assunto, ate o backfill rodar).
--
-- Idempotente: so CREATE OR REPLACE. Nenhuma tabela/constraint e tocada; as
-- linhas antigas seguem sem `assunto` no ref_obtencao ate o backfill atualizar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RPC de descoberta: grava o assunto no ref_obtencao (campo aditivo).
-- ---------------------------------------------------------------------
create or replace function public.descobrir_vinculos_gmail(
  p_itens jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_inseridos integer;
begin
  if jsonb_typeof(p_itens) <> 'array' then
    return 0;
  end if;

  with itens as (
    select
      nullif(x ->> 'message_id', '')                                   as message_id,
      nullif(x ->> 'thread_id', '')                                    as thread_id,
      coalesce(nullif(x ->> 'tipo', ''), 'anexo')                      as tipo,
      x ->> 'nome'                                                     as nome,
      nullif(x ->> 'attachment_id', '')                               as attachment_id,
      nullif(lower(regexp_replace(coalesce(x ->> 'extensao', ''), '^\.', '')), '') as ext,
      nullif(btrim(coalesce(x ->> 'assunto', '')), '')                 as assunto
    from jsonb_array_elements(p_itens) x
    where nullif(x ->> 'message_id', '') is not null                   -- sem id natural = inobtenivel
      and x ->> 'nome' is not null                                     -- nome distingue corpo vs anexos
  ),
  ins as (
    insert into public.documento_vinculos
      (fonte, registro_origem_id, nome_anexo, ref_obtencao, status_extracao)
    select 'gmail',
           itens.message_id,
           itens.nome,
           jsonb_build_object(
             'message_id', itens.message_id,
             'thread_id', itens.thread_id,
             'tipo', itens.tipo,
             'attachment_id', itens.attachment_id,
             'nome', itens.nome,
             'extensao', itens.ext,
             'assunto', itens.assunto
           ),
           'pendente'
    from itens
    on conflict (fonte, registro_origem_id, nome_anexo) do nothing
    returning 1
  )
  select count(*) into v_inseridos from ins;
  return v_inseridos;
end;
$$;

revoke all on function public.descobrir_vinculos_gmail(jsonb)
  from public, anon, authenticated;
grant execute on function public.descobrir_vinculos_gmail(jsonb)
  to service_role;

-- ---------------------------------------------------------------------
-- 2) View mestra: titulo e busca do Gmail derivados do assunto.
--    Recriada por inteiro (CREATE OR REPLACE) so para trocar Gmail/Drive:
--    Gmail = assunto (ref_obtencao do vinculo representativo) -> nome -> id;
--    Drive = nome do anexo (inalterado).
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
-- cabecalho Gmail/Drive (nome_anexo/assunto) e do captado_em das fontes nao-Effecti.
rep as (
  select distinct on (dv.fonte, dv.registro_origem_id)
    dv.fonte,
    dv.registro_origem_id,
    dv.id as rep_id,
    dv.nome_anexo as rep_nome_anexo,
    dv.documento_id as rep_documento_id,
    dv.created_at as rep_created_at,
    nullif(btrim(dv.ref_obtencao ->> 'assunto'), '') as rep_assunto
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
  -- Effecti = objeto; Nomus = id; Gmail = assunto -> nome -> id; Drive = nome.
  case
    when a.fonte = 'effecti' then coalesce(nullif(btrim(av.objeto), ''), a.registro_origem_id)
    when a.fonte = 'nomus' then a.registro_origem_id
    when a.fonte = 'gmail' then coalesce(r.rep_assunto, nullif(btrim(r.rep_nome_anexo), ''), a.registro_origem_id)
    else coalesce(nullif(btrim(r.rep_nome_anexo), ''), a.registro_origem_id)
  end as titulo_curto,
  r.rep_id,
  r.rep_nome_anexo,
  r.rep_documento_id,
  -- Texto unico para a busca server-side (case-insensitive, ja lowercased).
  case
    when a.fonte = 'effecti' then lower(coalesce(av.objeto, '') || ' ' || coalesce(av.orgao, ''))
    when a.fonte = 'nomus' then lower(a.registro_origem_id || ' ' || coalesce(np.pessoa, ''))
    when a.fonte = 'gmail' then lower(coalesce(r.rep_assunto, r.rep_nome_anexo, ''))
    else lower(coalesce(r.rep_nome_anexo, ''))
  end as busca_texto
from agg a
join rep r on r.fonte = a.fonte and r.registro_origem_id = a.registro_origem_id
left join public.avisos av on a.fonte = 'effecti' and av.effecti_id = a.registro_origem_id
left join public.nomus_processos np on a.fonte = 'nomus' and np.nomus_id = a.registro_origem_id;

comment on view public.vw_coleta_registros_mestra is
  'Lista mestra da guia Dados: 1 linha por (fonte, registro_origem_id) com contagens, status agregado, captado_em derivado, titulo (Gmail = assunto do e-mail) e vinculo representativo. Lida so via service_role pela Edge coleta-registros.';

revoke all on public.vw_coleta_registros_mestra from anon, authenticated;
grant select on public.vw_coleta_registros_mestra to service_role;
