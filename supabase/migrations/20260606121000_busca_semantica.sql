-- =====================================================================
-- Sprint: Backend - busca semantica e API LLM-ready /v1 da Lia
-- Migration 11/xx: RPC de busca semantica vetorial + segredo de servico
--
-- Objetivo:
--   1) public.busca_semantica_chunks(query_embedding, top_k): busca HNSW
--      por similaridade de cosseno (vector_cosine_ops) em aviso_chunks,
--      resolvendo cada match para avisos.conteudo_verbatim. SECURITY DEFINER
--      (a autorizacao e feita na borda pela Edge Function) e executavel
--      apenas por service_role.
--   2) RPCs de segredo de servico no Supabase Vault (RNF-01/RNF-02): a API
--      key de servico read-only da Lia (LIA_SERVICE_API_KEY) e guardada,
--      lida, rotacionada e revogada via Vault, distinta da service_role e da
--      sessao humana. Executaveis apenas por service_role (server-side).
-- =====================================================================

-- Vault ja habilitado em migrations anteriores; garantimos idempotencia.
create extension if not exists supabase_vault with schema vault;

-- ---------------------------------------------------------------------
-- busca_semantica_chunks: top-K chunks por similaridade de cosseno.
--
--   - O embedding da query chega como literal textual ("[v1,v2,...]") e e
--     convertido para vector(1024) (mesma dimensao do substrato/bge-m3),
--     evitando ambiguidade de tipo via PostgREST.
--   - Usa o operador <=> (cosine distance) coberto pelo indice HNSW
--     idx_aviso_chunks_embedding_hnsw (vector_cosine_ops, RNF-09).
--   - score = 1 - distancia_cosseno (maior = mais similar).
--   - Substrato sem embeddings indexados retorna ZERO linhas (a clausula
--     embedding is not null elimina chunks ainda nao indexados), distinto
--     de uma query valida cujos vizinhos existem.
--   - top_k e normalizado/limitado tambem aqui (defense in depth) em [1, 50].
--
-- SECURITY DEFINER: roda como owner e ignora a RLS de aviso_chunks/avisos
-- de proposito — a autorizacao (sessao humana OU API key da Lia) ja foi
-- garantida na Edge Function antes da chamada. Executavel so por service_role.
-- ---------------------------------------------------------------------
create or replace function public.busca_semantica_chunks(
  p_query_embedding text,
  p_top_k           int default 5
)
returns table (
  aviso_id uuid,
  score    double precision,
  verbatim text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    a.id                                                  as aviso_id,
    (1 - (c.embedding <=> p_query_embedding::vector(1024))) as score,
    a.conteudo_verbatim                                   as verbatim
  from public.aviso_chunks c
  join public.avisos a on a.id = c.aviso_id
  where c.embedding is not null
  order by c.embedding <=> p_query_embedding::vector(1024)
  limit greatest(1, least(coalesce(p_top_k, 5), 50));
$$;

comment on function public.busca_semantica_chunks(text, int) is
  'Busca semantica HNSW (cosine) em aviso_chunks resolvendo para avisos.conteudo_verbatim. Autorizacao feita na borda; somente service_role executa.';

revoke all on function public.busca_semantica_chunks(text, int) from public, anon, authenticated;
grant execute on function public.busca_semantica_chunks(text, int) to service_role;

-- ---------------------------------------------------------------------
-- set_service_secret: cria/atualiza um segredo de servico no Vault por nome
-- deterministico (ex.: LIA_SERVICE_API_KEY). Permite rotacao (RNF-01):
-- regravar o mesmo nome troca a chave em uso. Bloqueia segredo vazio.
-- ---------------------------------------------------------------------
create or replace function public.set_service_secret(
  p_name   text,
  p_secret text
)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id   uuid;
  v_description text := concat('Segredo de servico ', p_name, ' (RNF-01/RNF-02)');
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'nome do segredo vazio nao permitido' using errcode = '22023';
  end if;
  if p_secret is null or btrim(p_secret) = '' then
    raise exception 'segredo vazio nao permitido' using errcode = '22023';
  end if;

  select id into v_secret_id from vault.secrets where name = p_name;

  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_secret, p_name, v_description);
  else
    v_secret_id := vault.create_secret(p_secret, p_name, v_description);
  end if;

  return true;
end;
$$;

comment on function public.set_service_secret(text, text) is
  'Grava/rotaciona um segredo de servico (ex.: LIA_SERVICE_API_KEY) no Supabase Vault. Somente service_role.';

-- ---------------------------------------------------------------------
-- get_service_secret: le o segredo decifrado em runtime pelo nome.
-- Retorna null quando o segredo nao existe (ex.: chave ainda nao emitida).
-- ---------------------------------------------------------------------
create or replace function public.get_service_secret(
  p_name text
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  if p_name is null or btrim(p_name) = '' then
    return null;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = p_name;

  return v_secret;
end;
$$;

comment on function public.get_service_secret(text) is
  'Le em runtime o segredo de servico decifrado do Vault pelo nome. Somente service_role.';

-- ---------------------------------------------------------------------
-- revoke_service_secret: remove o segredo do Vault (revogacao, RNF-01).
-- Apos a revogacao, chamadas com a chave antiga deixam de autenticar.
-- Retorna true quando havia segredo removido; false quando nao existia.
-- ---------------------------------------------------------------------
create or replace function public.revoke_service_secret(
  p_name text
)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  if p_name is null or btrim(p_name) = '' then
    return false;
  end if;

  select id into v_secret_id from vault.secrets where name = p_name;
  if v_secret_id is null then
    return false;
  end if;

  delete from vault.secrets where id = v_secret_id;
  return true;
end;
$$;

comment on function public.revoke_service_secret(text) is
  'Revoga (remove) um segredo de servico do Vault pelo nome. Somente service_role.';

-- ---------------------------------------------------------------------
-- Hardening: segredos de servico so podem ser tocados por service_role
-- (uso server-side nas Edge Functions). Nenhuma sessao de usuario executa.
-- ---------------------------------------------------------------------
revoke all on function public.set_service_secret(text, text) from public, anon, authenticated;
revoke all on function public.get_service_secret(text) from public, anon, authenticated;
revoke all on function public.revoke_service_secret(text) from public, anon, authenticated;

grant execute on function public.set_service_secret(text, text) to service_role;
grant execute on function public.get_service_secret(text) to service_role;
grant execute on function public.revoke_service_secret(text) to service_role;
