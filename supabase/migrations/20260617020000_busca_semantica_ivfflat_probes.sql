-- =====================================================================
-- Indice vetorial do acervo + probes fixo na RPC de busca semantica.
--
-- Contexto: a instancia e micro (shared_buffers 256MB, maintenance_work_mem
-- 64MB). O HNSW de ~486k vetores vector(1024) precisa de ~2GB em memoria
-- para o grafo -> build fazia thrashing em disco (~17h, OOM/ECONNRESET).
-- Decisao: IVFFlat (build em minutos mesmo com pouca RAM; recall ajustavel
-- em runtime via ivfflat.probes, sem rebuild).
--
-- lists=700 (~sqrt(486k)); probes=40 escolhido por A/B (latencia x recall).
-- O probes vive como SET LOCAL dentro da RPC: a funcao tem clausula SET
-- (search_path), entao o GUC e revertido na saida; exige VOLATILE (SET nao
-- e permitido em funcao STABLE). ALTER FUNCTION ... SET ivfflat.probes nao
-- e usavel aqui (permission denied no GUC do pgvector p/ role nao-superuser).
--
-- Indice parcial where origem='documento' espelha o predicado da RPC.
-- =====================================================================

create index if not exists idx_memoria_chunks_embedding_ivfflat
  on public.memoria_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 700)
  where origem = 'documento';

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
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  -- IVFFlat: nº de listas sondadas por busca (recall x latencia).
  -- Revertido na saida porque a funcao tem clausula SET (search_path).
  set local ivfflat.probes = 40;

  return query
  with limites as (
    -- top-K normalizado/limitado (defense in depth) em [1, 50].
    select greatest(1, least(coalesce(p_limite, 5), 50)) as k
  ),
  -- top-K chunks do acervo por proximidade cosseno (usa o indice IVFFlat).
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
end;
$$;

comment on function public.busca_semantica_documentos(vector, int) is
  'Busca semantica IVFFlat (cosine, probes=40) focada no acervo de documentos extraidos (memoria_chunks origem=documento). Retorna trecho casado + documento de origem + fontes. Autorizacao na borda; somente service_role executa.';

-- Hardening: somente service_role executa (uso server-side nas Edge Functions).
revoke all on function public.busca_semantica_documentos(vector, int) from public, anon, authenticated;
grant execute on function public.busca_semantica_documentos(vector, int) to service_role;
