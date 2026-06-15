-- =====================================================================
-- Tool de busca semantica do ACERVO (documentos extraidos).
--
-- Contexto: o acervo indexado vive 100% em memoria_chunks com
-- origem='documento' e registro_id = documentos.id (vetores OpenAI
-- text-embedding-3-small, dim 1024). A RPC federada existente
-- (busca_semantica_chunks) so enxerga avisos + origem='processo' e nao
-- cobre os documentos. Esta RPC e focada e dedicada ao acervo.
--
-- Retorno por chunk: o trecho casado (verbatim), o documento de origem
-- (id + nome + tipo) e as fontes que apontam para ele (array agregado de
-- documento_vinculos.fonte, ex.: {effecti,nomus}). similaridade = cosine
-- score (1 - distancia). Um mesmo documento pode aparecer em mais de um
-- chunk; a deduplicacao/leitura integral fica a cargo do consumidor (Lia).
--
-- Uso do indice HNSW (vector_cosine_ops): o order by embedding <=>
-- p_embedding limit k roda direto sobre memoria_chunks, preservando o
-- indice. O join com documentos/vinculos so enriquece o top-K ja cortado.
--
-- SECURITY DEFINER, executavel APENAS por service_role: a autorizacao
-- (sessao humana OU API key da Lia) e garantida na borda (Edge Function).
-- =====================================================================

create or replace function public.busca_semantica_documentos(
  p_embedding vector(1024),
  p_limite    int default 5
)
returns table (
  documento_id   uuid,
  chunk_index    int,
  verbatim       text,
  similaridade   double precision,
  nome_arquivo   text,
  tipo_documento text,
  fontes         text[]
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with limites as (
    -- top-K normalizado/limitado (defense in depth) em [1, 50].
    select greatest(1, least(coalesce(p_limite, 5), 50)) as k
  ),
  -- top-K chunks do acervo por proximidade cosseno (usa o indice HNSW).
  match as (
    select
      m.registro_id                       as documento_id,
      m.chunk_index                       as chunk_index,
      m.verbatim                          as verbatim,
      (1 - (m.embedding <=> p_embedding)) as similaridade,
      (m.embedding <=> p_embedding)       as distancia
    from public.memoria_chunks m
    where m.origem = 'documento'
      and m.embedding is not null
    order by m.embedding <=> p_embedding
    limit (select k from limites)
  )
  select
    mt.documento_id,
    mt.chunk_index,
    mt.verbatim,
    mt.similaridade,
    d.nome_arquivo,
    d.tipo_documento,
    coalesce(
      (select array_agg(distinct v.fonte order by v.fonte)
         from public.documento_vinculos v
        where v.documento_id = mt.documento_id),
      '{}'::text[]
    ) as fontes
  from match mt
  left join public.documentos d on d.id = mt.documento_id
  order by mt.distancia;
$$;

comment on function public.busca_semantica_documentos(vector, int) is
  'Busca semantica HNSW (cosine) focada no acervo de documentos extraidos (memoria_chunks origem=documento). Retorna trecho casado + documento de origem + fontes. Autorizacao na borda; somente service_role executa.';

-- Hardening: somente service_role executa (uso server-side nas Edge Functions).
revoke all on function public.busca_semantica_documentos(vector, int) from public, anon, authenticated;
grant execute on function public.busca_semantica_documentos(vector, int) to service_role;
