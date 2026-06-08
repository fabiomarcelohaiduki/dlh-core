-- =====================================================================
-- Camada 1 do pipeline de documentos — DESCOBERTA de anexos (Effecti).
--   Irma agnostica de descobrir_vinculos_nomus: varre
--   avisos.payload_bruto->'anexos' e ENFILEIRA um documento_vinculos
--   (status='pendente') por anexo elegivel. O runner do Actions depois
--   consome a MESMA fila (action='pendentes', sem filtro de fonte), obtem
--   os bytes pelo adaptador 'effecti' (GET na URL publica do anexo), extrai
--   via Tika e empurra ao Edge documentos-ingerir — onde o dedup GLOBAL por
--   hash funde o que ja chegou por outra fonte (1 doc, N vinculos).
--
--   Tao barata e local quanto a do Nomus: nao baixa bytes, nao chama Tika,
--   nao usa LLM. So materializa a fila. Idempotente: ON CONFLICT
--   (fonte, registro_origem_id, nome_anexo) DO NOTHING.
--
--   registro_origem_id = avisos.effecti_id (id natural da fonte, NOT NULL).
--   ref_obtencao = como re-obter os bytes na fonte Effecti:
--     {"url": "<url publica do anexo>", "nome": "<nome>", "extensao": "<ext|null>"}
--   A URL do Compras Publicas e content-addressed (CDN, nao expira), entao
--   re-fetchavel por demanda — nao guardamos o binario.
--
--   PARAMETROS (administraveis pelo chamador, sem hardcode):
--     p_extensoes     allowlist de extensoes ja NORMALIZADAS (sem ponto,
--                     minusculas: 'pdf','docx','zip',...); null = todas.
--     p_limite_avisos teto de AVISOS varridos (mais novos primeiro,
--                     data_publicacao DESC); null = sem limite. NAO limita
--                     anexos: a paginacao do volume e a propria fila pendente.
--
--   CAVEAT DE EXTENSAO (difere do Nomus): o anexo do Effecti traz SO
--   {url, nome} — NAO ha campo 'extensao'. A ext e DERIVADA do final do nome,
--   menos confiavel: nomes sem extensao limpa (ex.: "EDITAL E ANEXOS 201KB")
--   produzem ext-lixo e seriam descartados por uma allowlist como ['pdf'].
--   Como o Tika detecta o tipo pelo CONTEUDO de qualquer forma, recomenda-se
--   p_extensoes=null (descobre tudo) e deixar o Tika decidir; a allowlist
--   serve so para um corte grosseiro quando se quer evitar tipos conhecidos.
--
--   Alteracao ADITIVA e idempotente. Nenhuma tabela/constraint e tocada.
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

-- So a borda (service_role) chama; bloqueia anon/authenticated direto
-- (espelha descobrir_vinculos_nomus).
revoke all on function public.descobrir_vinculos_effecti(text[], integer)
  from public, anon, authenticated;
grant execute on function public.descobrir_vinculos_effecti(text[], integer)
  to service_role;
