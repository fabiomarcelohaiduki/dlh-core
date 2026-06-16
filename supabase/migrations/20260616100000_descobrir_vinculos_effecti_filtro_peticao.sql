-- =====================================================================
-- Camada 1 / DESCOBERTA Effecti — FILTRO de pseudo-anexos de peticao.
--
--   Alguns avisos (portais egov, ex.: compras.rs.gov.br) listam em
--   payload_bruto->'anexos' um item "Esclarecimentos/Impugnacoes" cuja URL
--   aponta para a PAGINA de peticao eletronica do portal
--   (.../offerPetition/electronicRecord.ctlx?...), nao para um arquivo.
--   Esses pseudo-anexos viravam documento_vinculos pendentes que sempre
--   falhavam na extracao (a "extensao" derivada do nome = o nome inteiro,
--   barrado pela allowlist; o conteudo e HTML de sistema, nao documento).
--
--   FIX (prevencao na fonte): pula no CTE de anexos qualquer item cuja URL
--   seja de peticao eletronica. Criterio DETERMINISTICO por URL (especifico:
--   nao barra PDFs/docs legitimos). Aditivo e idempotente.
--
--   SQL DIRETO via pg (nunca supabase db push). create or replace.
-- =====================================================================

create or replace function public.descobrir_vinculos_effecti(
  p_extensoes     text[] default null,
  p_limite_avisos integer default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_inseridos integer;
begin
  with avs as (
    select a.effecti_id, a.payload_bruto
    from public.avisos a
    where a.effecti_id is not null
      and jsonb_typeof(a.payload_bruto -> 'anexos') = 'array'
    order by a.data_publicacao desc nulls last
    limit p_limite_avisos                         -- null => sem limite
  ),
  anexos as (
    select avs.effecti_id,
           x ->> 'nome' as nome,
           x ->> 'url'  as url,
           regexp_replace(
             lower(regexp_replace(coalesce(x ->> 'nome', ''), '^.*\.', '')),
             '^\.', ''
           ) as ext
    from avs,
         lateral jsonb_array_elements(avs.payload_bruto -> 'anexos') x
    where x ->> 'nome' is not null
      and x ->> 'url'  is not null               -- sem url = inobtenivel
      -- Pseudo-anexo de peticao eletronica (pagina do portal, nao arquivo).
      and x ->> 'url' not ilike '%/offerPetition/%'
      and x ->> 'url' not ilike '%electronicRecord%'
  ),
  ins as (
    insert into public.documento_vinculos
      (fonte, registro_origem_id, nome_anexo, ref_obtencao, status_extracao)
    select 'effecti',
           anexos.effecti_id,
           anexos.nome,
           jsonb_build_object(
             'url', anexos.url,
             'nome', anexos.nome,
             'extensao', nullif(anexos.ext, '')
           ),
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

revoke all on function public.descobrir_vinculos_effecti(text[], integer)
  from public, anon, authenticated;
grant execute on function public.descobrir_vinculos_effecti(text[], integer)
  to service_role;
