-- =====================================================================
-- Migration: disparar_workflow_nomus ganha p_gatilho (manual x agendada)
--
-- O disparo manual pelo card Nomus (botoes "Coletar agora"/"full") caia sempre
-- como "Agendada" na tela de execucoes: a RPC nao passava gatilho ao workflow,
-- entao o runner (coletar-nomus.mjs) lia NOMUS_GATILHO ausente e usava o default
-- 'agendada' nos push bodies. Agora a RPC propaga o gatilho via inputs.gatilho do
-- workflow_dispatch; a Edge nomus-disparar chama com 'manual'. O agendamento
-- (pg_cron coleta-nomus-processos) continua sem passar gatilho -> runner cai no
-- default 'agendada' (correto). Espelha o fix do Gmail (20260610060000).
--
-- A 2-arg disparar_workflow_nomus(text, text) e DROPADA para evitar ambiguidade
-- com a nova 3-arg (default). Re-grant para service_role (Edge nomus-disparar).
-- Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL).
-- =====================================================================

drop function if exists public.disparar_workflow_nomus(text, text);

create or replace function public.disparar_workflow_nomus(
  p_modo    text,
  p_recurso text default 'processos',
  p_gatilho text default 'manual'
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
  v_gatilho  text := case when p_gatilho = 'manual' then 'manual' else 'agendada' end;
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

  -- workflow_dispatch: aciona o workflow no master com modo+recurso+gatilho. O
  -- gatilho (manual|agendada) deixa a tela de execucoes distinguir disparo
  -- manual do agendado.
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
                 'inputs', jsonb_build_object('modo', p_modo, 'recurso', p_recurso, 'gatilho', v_gatilho)
               )
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.disparar_workflow_nomus(text, text, text) is
  'Dispara manualmente o workflow GitHub Actions coletar-nomus.yml (workflow_dispatch) no modo (incremental|full), recurso/modulo e gatilho (manual|agendada) informados, usando GITHUB_DISPATCH_TOKEN do Vault. Chamada server-side pela Edge nomus-disparar (manual).';

revoke all on function public.disparar_workflow_nomus(text, text, text) from public, anon, authenticated;
grant execute on function public.disparar_workflow_nomus(text, text, text) to service_role;
