-- =====================================================================
-- Camada 1 do pipeline de documentos — DESCOBERTA de anexos (Nomus).
--   Varre nomus_processos.payload_bruto->'arquivosAnexos' e ENFILEIRA um
--   documento_vinculos (status='pendente') por anexo elegivel. O runner do
--   Actions depois consome essa fila (action='pendentes'), obtem os bytes
--   por adaptador, extrai via Tika e empurra ao Edge documentos-ingerir.
--
--   A descoberta e BARATA e LOCAL ao Postgres (os processos ja estao no
--   Supabase): nao baixa bytes, nao chama Tika, nao usa LLM. So materializa
--   a fila. Idempotente: ON CONFLICT (fonte, registro_origem_id, nome_anexo)
--   DO NOTHING -> rodar de novo nao duplica nada, so pega anexos ineditos.
--
--   ref_obtencao = como re-obter os bytes na fonte Nomus:
--     {"processo_id": "<nomus_id>", "nome": "<nome do anexo>"}  (base64 no
--     GET individual /rest/processos/{id}).
--
--   PARAMETROS (administraveis pelo chamador, sem hardcode):
--     p_tipo         filtra por nomus_processos.tipo (ex.: 'Venda
--                    Governamental'); null = todos os tipos.
--     p_extensoes    allowlist de extensoes ja NORMALIZADAS (sem ponto,
--                    minusculas: 'pdf','docx',...); null = todas.
--     p_limite_procs teto de PROCESSOS varridos (mais novos primeiro, id
--                    DESC); null = sem limite (descobre tudo). NAO limita
--                    anexos: a paginacao do volume e a propria fila pendente.
--
--   NORMALIZACAO DE EXTENSAO: o payload guarda extensao COM ponto (".pdf");
--   normaliza tirando o ponto e, na falta, deriva do final do nome. Mesma
--   regra usada na descoberta validada (2026-06-08, lote de 47).
--
--   Alteracao ADITIVA e idempotente. Nenhuma tabela/constraint e tocada.
-- =====================================================================

create or replace function public.descobrir_vinculos_nomus(
  p_tipo          text default null,
  p_extensoes     text[] default null,
  p_limite_procs  integer default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_inseridos integer;
begin
  with procs as (
    select p.nomus_id, p.payload_bruto
    from public.nomus_processos p
    where p.nomus_id ~ '^[0-9]+$'                 -- guarda o cast do order by
      and (p_tipo is null or p.tipo = p_tipo)
      and jsonb_typeof(p.payload_bruto -> 'arquivosAnexos') = 'array'
    order by (p.nomus_id)::bigint desc
    limit p_limite_procs                          -- null => sem limite
  ),
  anexos as (
    select procs.nomus_id,
           a ->> 'nome' as nome,
           regexp_replace(
             lower(coalesce(
               nullif(a ->> 'extensao', ''),
               regexp_replace(a ->> 'nome', '^.*\.', '')
             )),
             '^\.', ''
           ) as ext
    from procs,
         lateral jsonb_array_elements(procs.payload_bruto -> 'arquivosAnexos') a
    where a ->> 'nome' is not null
  ),
  ins as (
    insert into public.documento_vinculos
      (fonte, registro_origem_id, nome_anexo, ref_obtencao, status_extracao)
    select 'nomus',
           anexos.nomus_id,
           anexos.nome,
           jsonb_build_object('processo_id', anexos.nomus_id, 'nome', anexos.nome),
           'pendente'
    from anexos
    where (p_extensoes is null or anexos.ext = any (p_extensoes))
    on conflict (fonte, registro_origem_id, nome_anexo) do nothing
    returning 1
  )
  select count(*) into v_inseridos from ins;
  return v_inseridos;
end;
$$;

-- So a borda (service_role) chama; bloqueia anon/authenticated direto
-- (espelha nomus_max_nomus_id / aplicar_agendamento).
revoke all on function public.descobrir_vinculos_nomus(text, text[], integer)
  from public, anon, authenticated;
grant execute on function public.descobrir_vinculos_nomus(text, text[], integer)
  to service_role;
