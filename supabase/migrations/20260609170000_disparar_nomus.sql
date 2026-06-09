-- =====================================================================
-- Migration: Disparo MANUAL do workflow Nomus (full | incremental)
--
-- Decisao (09/06): o card da fonte Nomus ganha botoes de disparo manual da
-- coleta direto do cockpit, sem abrir a UI do GitHub Actions. Reusa o mesmo
-- alvo do agendamento (workflow_dispatch via GitHub REST API), mas aqui o
-- ACIONAMENTO e on-demand e o MODO e escolhido pelo painel:
--   - incremental: regime permanente (watermark por id).
--   - full: backfill historico completo (varre tudo de novo).
--
-- A funcao roda SECURITY DEFINER e e chamada server-side pela Edge
-- nomus-disparar (que exige sessao autorizada + audit). Le o mesmo segredo
-- GITHUB_DISPATCH_TOKEN do Vault usado pelo pg_cron de agendamento.
--
-- Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
-- padrao do projeto (schema_migrations remoto intencionalmente atrasado).
-- =====================================================================

create or replace function public.disparar_workflow_nomus(p_modo text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_gh_url   text := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-nomus.yml/dispatches';
  v_gh_token text;
  v_req_id   bigint;
begin
  -- Valida o modo (mesma allowlist do input do workflow).
  if p_modo is null or p_modo not in ('incremental', 'full') then
    raise exception 'modo invalido: %', p_modo;
  end if;

  -- Segredo do Vault: PAT fine-grained (Actions RW no dlh-core).
  select decrypted_secret into v_gh_token
    from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
  if v_gh_token is null then
    raise exception 'segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
  end if;

  -- workflow_dispatch: aciona o workflow no branch master com o modo escolhido.
  select net.http_post(
    url     := v_gh_url,
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_gh_token,
                 'Accept', 'application/vnd.github+json',
                 'X-GitHub-Api-Version', '2022-11-28',
                 'User-Agent', 'dlh-core-cron',
                 'Content-Type', 'application/json'
               ),
    body    := jsonb_build_object(
                 'ref', 'master',
                 'inputs', jsonb_build_object('modo', p_modo)
               )
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.disparar_workflow_nomus(text) is
  'Dispara manualmente o workflow GitHub Actions coletar-nomus.yml (workflow_dispatch) no modo informado (incremental|full), usando GITHUB_DISPATCH_TOKEN do Vault. Chamada server-side pela Edge nomus-disparar.';

-- Acesso a RPC: somente service_role (a Edge nomus-disparar invoca
-- server-side). Bloqueia chamada direta por anon/authenticated.
revoke all on function public.disparar_workflow_nomus(text) from public, anon, authenticated;
grant execute on function public.disparar_workflow_nomus(text) to service_role;
