-- =====================================================================
-- Migration: disparar_workflow_gmail ganha p_gatilho (manual x agendada)
--
-- O disparo manual pelo card Gmail caia sempre como "Agendada" na tela de
-- execucoes: a RPC nao passava nenhum input ao workflow, entao o runner
-- (descobrir-gmail.mjs) lia GMAIL_GATILHO ausente e usava o default 'agendada'.
-- Agora a RPC propaga o gatilho via inputs.gatilho do workflow_dispatch; a Edge
-- gmail-disparar chama com 'manual'. O agendamento (pg_cron) continua sem passar
-- input -> runner cai no default 'agendada' (correto).
--
-- Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL).
-- =====================================================================

create or replace function public.disparar_workflow_gmail(p_gatilho text default 'manual')
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_gh_url   text := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-gmail.yml/dispatches';
  v_gh_token text;
  v_req_id   bigint;
  v_gatilho  text := case when p_gatilho = 'manual' then 'manual' else 'agendada' end;
begin
  -- Segredo do Vault: PAT fine-grained (Actions RW no dlh-core), o mesmo do Nomus.
  select decrypted_secret into v_gh_token
    from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
  if v_gh_token is null then
    raise exception 'segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
  end if;

  -- workflow_dispatch: aciona coletar-gmail.yml no branch master. A query e
  -- montada pelo gmail-config no runner; o unico input e o gatilho (p/ a tela
  -- de execucoes distinguir disparo manual de agendado).
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
                 'inputs', jsonb_build_object('gatilho', v_gatilho)
               )
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.disparar_workflow_gmail(text) is
  'Dispara o workflow GitHub Actions coletar-gmail.yml (workflow_dispatch) com inputs.gatilho (manual|agendada): descobre as mensagens do Gmail (query do gmail-config) e enfileira na fila de documentos, independente da extracao. Usa GITHUB_DISPATCH_TOKEN do Vault. Chamada server-side pela Edge gmail-disparar (manual).';

-- A assinatura 0-arg anterior foi substituida pela 1-arg (default 'manual').
drop function if exists public.disparar_workflow_gmail();

-- Acesso a RPC: somente service_role (a Edge gmail-disparar invoca
-- server-side). Bloqueia chamada direta por anon/authenticated.
revoke all on function public.disparar_workflow_gmail(text) from public, anon, authenticated;
grant execute on function public.disparar_workflow_gmail(text) to service_role;
