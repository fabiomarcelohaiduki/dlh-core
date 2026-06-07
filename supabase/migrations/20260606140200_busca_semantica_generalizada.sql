-- =====================================================================
-- Feature Nomus Processos (secao 2.3 da SPEC - DD-03)
-- Migration: Generalizacao ADITIVA da RPC busca_semantica_chunks.
--
-- A RPC passa a ser ORIGEM-AWARE: faz union entre aviso_chunks (busca de
-- avisos, intacta) e memoria_chunks (memoria agnostica de origem), conforme
-- o escopo solicitado. Mudanca estritamente aditiva (DD-03):
--   - Assinatura: busca_semantica_chunks(p_embedding vector(1024),
--                 p_limite int, p_escopo text DEFAULT null).
--   - Retorno preserva aviso_id, verbatim e similaridade (campos hoje
--     consumidos pela Lia) e ADICIONA origem e registro_id. Nenhum campo
--     e removido/renomeado semanticamente.
--   - p_escopo (OPCIONAL): null/'tudo' = federado (avisos + processos);
--     'avisos' = so aviso_chunks; 'processos' = memoria_chunks origem='processo';
--     tipo especifico (ex.: 'processo-venda-governamental') = filtra por tipo.
--
-- Continua SECURITY DEFINER, executavel APENAS por service_role (SEC-06):
-- a autorizacao (sessao humana OU API key da Lia) ja foi garantida na borda
-- (Edge Function) antes da chamada.
--
-- Uso do indice HNSW (RNF-08): cada ramo do union faz seu proprio
-- "order by embedding <=> p_embedding limit k" sobre a respectiva tabela,
-- preservando o uso do indice vector_cosine_ops em ambas. O filtro de escopo
-- (constante de parametro / coluna discriminadora) nao impede o uso do indice.
-- =====================================================================

-- A assinatura muda (tipo do 1o parametro + colunas de retorno), portanto
-- nao e possivel CREATE OR REPLACE: removemos a versao anterior (text, int)
-- explicitamente antes de recriar.
drop function if exists public.busca_semantica_chunks(text, int);

create or replace function public.busca_semantica_chunks(
  p_embedding vector(1024),
  p_limite    int  default 5,
  p_escopo    text default null
)
returns table (
  aviso_id     uuid,
  verbatim     text,
  similaridade double precision,
  origem       text,
  registro_id  uuid
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
  -- Ramo AVISOS (aviso_chunks -> avisos.conteudo_verbatim). Para um aviso,
  -- a referencia generica registro_id e o proprio id do aviso; origem='aviso'.
  -- Ativo quando escopo e null/'tudo'/'avisos'. score = 1 - distancia_cosseno.
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
    order by c.embedding <=> p_embedding
    limit (select k from limites)
  ),
  -- Ramo MEMORIA (memoria_chunks; processos e demais origens futuras).
  -- aviso_id e null (nao ha aviso); registro_id e a ref generica (ex.:
  -- nomus_processos.id) e origem vem da propria linha. Ativo quando escopo
  -- e null/'tudo'/'processos' (restrito a origem='processo') OU quando o
  -- escopo casa exatamente com o tipo do chunk (filtro fino por tipo).
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
        -- federado / 'processos': foca a memoria de processos.
        ((p_escopo is null or p_escopo in ('tudo', 'processos')) and m.origem = 'processo')
        -- tipo especifico: filtra estritamente pelo tipo do chunk.
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
$$;

comment on function public.busca_semantica_chunks(vector, int, text) is
  'Busca semantica HNSW (cosine) origem-aware: union de aviso_chunks e memoria_chunks conforme p_escopo (null/tudo=federado; avisos; processos; ou tipo). Retorno aditivo (DD-03): aviso_id, verbatim, similaridade, origem, registro_id. Autorizacao na borda; somente service_role executa.';

-- Hardening: somente service_role executa (uso server-side nas Edge Functions).
revoke all on function public.busca_semantica_chunks(vector, int, text) from public, anon, authenticated;
grant execute on function public.busca_semantica_chunks(vector, int, text) to service_role;
