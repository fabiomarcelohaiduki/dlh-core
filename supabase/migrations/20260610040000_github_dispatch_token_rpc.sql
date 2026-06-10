-- =====================================================================
-- Migration: RPC github_dispatch_token() — leitura server-side do PAT
--
-- POR QUE: o guard anti-duplo-disparo do gmail-disparar (Edge) checa a tabela
-- execucoes, mas a execucao do Gmail so nasce quando o runner do Actions sobe
-- (~60s de setup). Nessa janela um 2o disparo passa e enfileira um run
-- redundante (concurrency segura o paralelismo, mas gasta minutos Actions e
-- confunde o painel). Para fechar a janela, o Edge consulta a GitHub API por
-- runs ativos do coletar-gmail.yml (aparecem como queued no instante do
-- dispatch) — e para isso precisa do PAT.
--
-- pg_net e ASSINCRONO (nao da resposta sincrona dentro de uma RPC) e a extensao
-- http sincrona nao esta instalada, entao a checagem roda no Edge (Deno fetch).
-- Esta RPC apenas devolve o GITHUB_DISPATCH_TOKEN do Vault para o Edge ler
-- server-side. NAO amplia a superficie: quem tem service_role ja le o Vault.
--
-- SECURITY DEFINER + grant SO para service_role (anon/authenticated revogados).
-- Aplicar via Node `pg` (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

create or replace function public.github_dispatch_token()
returns text
language sql
security definer
set search_path = public, extensions
as $$
  select decrypted_secret
    from vault.decrypted_secrets
   where name = 'GITHUB_DISPATCH_TOKEN'
   limit 1;
$$;

comment on function public.github_dispatch_token() is
  'Devolve o GITHUB_DISPATCH_TOKEN do Vault para uso server-side (Edge gmail-disparar checar runs ativos do Actions antes de disparar). Restrita a service_role.';

revoke all on function public.github_dispatch_token() from public, anon, authenticated;
grant execute on function public.github_dispatch_token() to service_role;
