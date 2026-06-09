-- =====================================================================
-- Camada 1 do pipeline de documentos — DESCOBERTA do Gmail.
--   Irma agnostica das de Nomus/Effecti/Drive. Como no Drive, a verdade
--   vive na API do Google (a lista de mensagens nao esta no banco): o RUNNER
--   (descobrir-gmail.mjs) consulta o Gmail, monta os itens e passa a LISTA
--   pronta (p_itens jsonb) para esta funcao materializar a fila.
--
--   COLETA POR MENSAGEM (decisao Fabio 2026-06-09): cada email vira ATE dois
--   tipos de vinculo na MESMA fila de documentos:
--     - 'corpo'  -> o texto da mensagem (ja sem o trecho citado da thread),
--                   entregue como .txt; o extrator decodifica no Node (sem Tika).
--     - 'anexo'  -> cada anexo do email; o runner baixa os bytes e o Tika extrai.
--   O thread_id e guardado em ref_obtencao para reconstruir a conversa depois
--   (contexto / camada 2), SEM virar unidade de extracao.
--
--   IMUTABILIDADE: o conteudo de uma mensagem do Gmail nao muda (message_id
--   estavel). Logo, diferente do Drive (arquivo editavel), aqui basta
--   INSERT ... ON CONFLICT DO NOTHING — nenhuma reabertura/assinatura.
--   Novas mensagens numa thread = novos message_id = novos vinculos, captados
--   na proxima descoberta. O dedup GLOBAL por hash (no Edge) funde o mesmo
--   edital que chegue por varias mensagens/fontes (1 doc, N vinculos).
--
--   registro_origem_id = message_id (id natural da mensagem, NOT NULL).
--   nome_anexo         = nome do item (corpo: "(corpo).txt"; anexo: filename).
--   ref_obtencao       = como re-obter os bytes na fonte Gmail:
--     corpo: {"message_id","thread_id","tipo":"corpo","nome","extensao":"txt"}
--     anexo: {"message_id","thread_id","tipo":"anexo","attachment_id","nome","extensao"}
--
--   p_itens = jsonb array vindo do runner; cada item:
--     {"message_id","thread_id","tipo","nome","attachment_id"?,"extensao"?}
--
--   Alteracao ADITIVA e idempotente. Nenhuma tabela/constraint e tocada.
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
      nullif(lower(regexp_replace(coalesce(x ->> 'extensao', ''), '^\.', '')), '') as ext
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
             'extensao', itens.ext
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

-- So a borda (service_role) chama; bloqueia anon/authenticated direto
-- (espelha descobrir_vinculos_nomus/effecti/drive).
revoke all on function public.descobrir_vinculos_gmail(jsonb)
  from public, anon, authenticated;
grant execute on function public.descobrir_vinculos_gmail(jsonb)
  to service_role;
