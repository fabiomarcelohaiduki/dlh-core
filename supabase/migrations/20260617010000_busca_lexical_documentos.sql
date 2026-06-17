-- =====================================================================
-- Tool de busca LEXICAL (full-text) do ACERVO — perna BM25-like do hybrid.
--
-- Contexto: a busca semantica (busca_semantica_documentos) e vetorial PURA
-- e e fraca em TERMO EXATO (numero de edital/pregao, UASG, CATMAT, CNPJ,
-- chave NF-e/CT-e, sigla, codigo de produto) — justamente o que abunda no
-- acervo de licitacao. Esta RPC adiciona a perna lexical: full-text do
-- Postgres (to_tsvector/websearch_to_tsquery em 'portuguese') ranqueada por
-- ts_rank_cd com normalizacao por tamanho de documento (flag 1, log do
-- comprimento) — aproxima o comportamento do BM25 sem extensao externa
-- (ParadeDB/pg_search nao estao disponiveis no Supabase). A fusao com o
-- vetorial (RRF) e o rerank ficam na Edge; aqui so produzimos o ranking
-- lexical do top-K.
--
-- Indice: GIN sobre to_tsvector('portuguese', verbatim), parcial em
-- origem='documento' (todo o acervo hoje), criado CONCURRENTLY fora de
-- transacao para nao travar escrita durante o backfill/indexacao. O
-- predicado da RPC casa EXATAMENTE a expressao indexada para o planner usar
-- o indice.
--
-- SECURITY DEFINER, executavel APENAS por service_role: a autorizacao
-- (sessao humana OU API key da Lia) e garantida na borda (Edge Function),
-- espelhando busca_semantica_documentos.
-- =====================================================================

-- Indice GIN parcial. CRIAR CONCURRENTLY (fora de qualquer transacao); o
-- runner pg aplica este statement isolado, em autocommit.
create index concurrently if not exists idx_memoria_chunks_busca_lexical
  on public.memoria_chunks
  using gin (to_tsvector('portuguese', verbatim))
  where origem = 'documento';

create or replace function public.busca_lexical_documentos(
  p_query  text,
  p_limite int default 50
)
returns table (
  documento_id   uuid,
  chunk_index    int,
  verbatim       text,
  rank_lexical   double precision,
  nome_arquivo   text,
  tipo_documento text,
  fontes         text[]
)
language sql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
  with limites as (
    -- top-K normalizado/limitado (defense in depth) em [1, 50].
    select greatest(1, least(coalesce(p_limite, 50), 50)) as k
  ),
  consulta as (
    -- websearch_to_tsquery: aceita sintaxe de busca do usuario e NUNCA
    -- retorna NULL (query vazia => casa nada, sem erro).
    select websearch_to_tsquery('portuguese', coalesce(p_query, '')) as q
  ),
  -- top-K chunks por relevancia lexical (usa o indice GIN parcial).
  match as (
    select
      m.registro_id as documento_id,
      m.chunk_index as chunk_index,
      m.verbatim    as verbatim,
      ts_rank_cd(
        to_tsvector('portuguese', m.verbatim),
        (select q from consulta),
        1  -- normalizacao por log do comprimento do documento (BM25-like).
      ) as rank_lexical
    from public.memoria_chunks m
    where m.origem = 'documento'
      and to_tsvector('portuguese', m.verbatim) @@ (select q from consulta)
    order by rank_lexical desc
    limit (select k from limites)
  )
  select
    mt.documento_id,
    mt.chunk_index,
    mt.verbatim,
    mt.rank_lexical,
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
  order by mt.rank_lexical desc;
$$;

comment on function public.busca_lexical_documentos(text, int) is
  'Busca lexical full-text (BM25-like via ts_rank_cd) focada no acervo de documentos (memoria_chunks origem=documento). Perna lexical do hybrid search; fusao RRF + rerank na borda. Autorizacao na borda; somente service_role executa.';

-- Hardening: somente service_role executa (uso server-side nas Edge Functions).
revoke all on function public.busca_lexical_documentos(text, int) from public, anon, authenticated;
grant execute on function public.busca_lexical_documentos(text, int) to service_role;
