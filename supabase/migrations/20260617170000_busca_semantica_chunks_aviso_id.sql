-- =====================================================================
-- Sprint Triagem — Migration 5/6: RPC busca_semantica_chunks + p_aviso_id.
--
-- A triagem precisa recuperar trechos DENTRO de um aviso especifico (RAG
-- intra-aviso) sem perder a busca federada existente. Estendemos a RPC
-- origem-aware adicionando o parametro OPCIONAL p_aviso_id: quando informado,
-- o ramo de avisos filtra aviso_chunks.aviso_id = p_aviso_id (busca restrita
-- aquele aviso); quando null, comportamento federado atual e preservado.
--
-- A assinatura muda (novo 4o parametro) => DROP da versao anterior
-- (vector, int, text) e CREATE da nova (vector, int, text, uuid default null).
-- Os campos de retorno (aviso_id, verbatim, similaridade, origem, registro_id)
-- sao PRESERVADOS integralmente (consumo da Lia intacto).
--
-- A funcao passa a ser VOLATILE para poder aplicar SET LOCAL ivfflat.probes
-- (GUC revertido na saida pela clausula SET da funcao). cap em 50 mantido.
-- SECURITY DEFINER; somente service_role executa (autorizacao na borda).
-- =====================================================================

drop function if exists public.busca_semantica_chunks(vector, int, text);

create or replace function public.busca_semantica_chunks(
  p_embedding vector(1024),
  p_limite    int  default 5,
  p_escopo    text default null,
  p_aviso_id  uuid default null
)
returns table (
  aviso_id     uuid,
  verbatim     text,
  similaridade double precision,
  origem       text,
  registro_id  uuid
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  -- IVFFlat: nº de listas sondadas por busca (recall x latencia). Revertido
  -- na saida porque a funcao tem clausula SET (search_path).
  set local ivfflat.probes = 40;

  return query
  with limites as (
    -- top-K normalizado/limitado (defense in depth) em [1, 50].
    select greatest(1, least(coalesce(p_limite, 5), 50)) as k
  ),
  -- Ramo AVISOS (aviso_chunks -> avisos.conteudo_verbatim). registro_id e o
  -- proprio id do aviso; origem='aviso'. Ativo quando escopo e null/'tudo'/
  -- 'avisos'. Quando p_aviso_id e informado, restringe a esse aviso (RAG
  -- intra-aviso). score = 1 - distancia_cosseno.
  avisos_match as (
    select
      a.id                                  as aviso_id,
      a.conteudo_verbatim                   as verbatim,
      (1 - (c.embedding <=> p_embedding))   as similaridade,
      'aviso'::text                         as origem,
      a.id                                  as registro_id,
      (c.embedding <=> p_embedding)         as distancia
    from public.aviso_chunks c
    join public.avisos a on a.id = c.aviso_id
    where c.embedding is not null
      and (p_escopo is null or p_escopo in ('tudo', 'avisos'))
      and (p_aviso_id is null or c.aviso_id = p_aviso_id)
    order by c.embedding <=> p_embedding
    limit (select k from limites)
  ),
  -- Ramo MEMORIA (memoria_chunks; processos e demais origens). aviso_id e null;
  -- registro_id e a ref generica e origem vem da propria linha. Ativo quando
  -- escopo e null/'tudo'/'processos' (origem='processo') OU quando o escopo
  -- casa exatamente com o tipo do chunk. p_aviso_id nao se aplica aqui.
  processos_match as (
    select
      null::uuid                            as aviso_id,
      m.verbatim                            as verbatim,
      (1 - (m.embedding <=> p_embedding))   as similaridade,
      m.origem                              as origem,
      m.registro_id                         as registro_id,
      (m.embedding <=> p_embedding)         as distancia
    from public.memoria_chunks m
    where m.embedding is not null
      and (
        ((p_escopo is null or p_escopo in ('tudo', 'processos')) and m.origem = 'processo')
        or (p_escopo is not null and p_escopo not in ('tudo', 'avisos', 'processos') and m.tipo = p_escopo)
      )
    order by m.embedding <=> p_embedding
    limit (select k from limites)
  )
  select u.aviso_id, u.verbatim, u.similaridade, u.origem, u.registro_id
  from (
    select * from avisos_match
    union all
    select * from processos_match
  ) u
  order by u.distancia
  limit (select k from limites);
end;
$$;

comment on function public.busca_semantica_chunks(vector, int, text, uuid) is
  'Busca semantica origem-aware (IVFFlat probes=40, cosine): union de aviso_chunks e memoria_chunks conforme p_escopo (null/tudo=federado; avisos; processos; ou tipo). p_aviso_id opcional restringe o ramo de avisos a um aviso (RAG intra-aviso). Retorno preservado: aviso_id, verbatim, similaridade, origem, registro_id. Autorizacao na borda; somente service_role executa.';

-- Hardening: somente service_role executa (uso server-side nas Edge Functions).
revoke all on function public.busca_semantica_chunks(vector, int, text, uuid) from public, anon, authenticated;
grant execute on function public.busca_semantica_chunks(vector, int, text, uuid) to service_role;
