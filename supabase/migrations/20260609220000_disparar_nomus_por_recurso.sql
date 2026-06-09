-- =====================================================================
-- Migration: disparo MANUAL do Nomus passa a ser POR RECURSO (modulo)
--
-- Decisao (09/06, "separe de verdade"): o disparo manual (botoes do card)
-- ganha o recurso alvo, alinhado ao agendamento por recurso. Hoje so
-- 'processos' coleta; o default 'processos' mantem o comportamento atual.
--
-- A 1-arg disparar_workflow_nomus(text) e DROPADA para evitar ambiguidade
-- com a nova 2-arg (default). Re-grant para service_role (Edge nomus-disparar).
-- Idempotente. Aplicar via Node `pg` (SUPABASE_DB_URL).
-- =====================================================================

drop function if exists public.disparar_workflow_nomus(text);

create or replace function public.disparar_workflow_nomus(
  p_modo    text,
  p_recurso text default 'processos'
)
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
  if p_recurso is null or p_recurso = '' then
    raise exception 'recurso invalido: %', p_recurso;
  end if;

  -- Segredo do Vault: PAT fine-grained (Actions RW no dlh-core).
  select decrypted_secret into v_gh_token
    from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
  if v_gh_token is null then
    raise exception 'segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
  end if;

  -- workflow_dispatch: aciona o workflow no master com o modo+recurso escolhidos.
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
                 'inputs', jsonb_build_object('modo', p_modo, 'recurso', p_recurso)
               )
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.disparar_workflow_nomus(text, text) is
  'Dispara manualmente o workflow GitHub Actions coletar-nomus.yml (workflow_dispatch) no modo (incremental|full) e recurso/modulo informados, usando GITHUB_DISPATCH_TOKEN do Vault. Chamada server-side pela Edge nomus-disparar.';

revoke all on function public.disparar_workflow_nomus(text, text) from public, anon, authenticated;
grant execute on function public.disparar_workflow_nomus(text, text) to service_role;
