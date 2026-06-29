-- =====================================================================
-- Gmail: metadados do e-mail (remetente, destinatarios, copia, data) no
-- ref_obtencao, para o cabecalho da guia Dados.
--
-- ANTES: o cabecalho do registro Gmail na guia Dados mostrava apenas anexo,
-- extensao, tipo e thread. Faltava o contexto do proprio e-mail -- de quem
-- veio, para quem foi, quem estava em copia e quando foi enviado.
--
-- AGORA: a Edge gmail-coletar le os headers MIME From/To/Cc/Date e propaga
-- remetente/destinatarios/cc/data_email em cada item; documentos-descobrir
-- repassa; esta migration faz descobrir_vinculos_gmail gravar esses campos
-- dentro do ref_obtencao (jsonb que ja carrega thread_id/tipo/nome/assunto).
-- A Edge coleta-registros le esses campos do vinculo representativo e os
-- expoe no cabecalho discriminado do Gmail.
--
-- ADITIVO E SEGURO: so CREATE OR REPLACE da RPC, acrescentando 4 chaves ao
-- jsonb_build_object. A view vw_coleta_registros_mestra NAO e tocada (os
-- metadados aparecem so no detalhe, nao no titulo/busca da lista). E-mails
-- ja coletados seguem sem esses campos no ref_obtencao ate a proxima coleta
-- re-gravar o vinculo (mesmo comportamento retroativo do assunto).
-- =====================================================================

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
      nullif(btrim(coalesce(x ->> 'assunto', '')), '')                 as assunto,
      nullif(btrim(coalesce(x ->> 'remetente', '')), '')               as remetente,
      nullif(btrim(coalesce(x ->> 'destinatarios', '')), '')           as destinatarios,
      nullif(btrim(coalesce(x ->> 'cc', '')), '')                      as cc,
      nullif(btrim(coalesce(x ->> 'data_email', '')), '')              as data_email
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
             'assunto', itens.assunto,
             'remetente', itens.remetente,
             'destinatarios', itens.destinatarios,
             'cc', itens.cc,
             'data_email', itens.data_email
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
