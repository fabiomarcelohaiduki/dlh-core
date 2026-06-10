-- =====================================================================
-- Migration: Disparo MANUAL da EXTRACAO/Drive (workflow_dispatch)
--
-- O Drive nao tem coleta propria: a sua descoberta acontece DENTRO do workflow
-- extrair-anexos.yml (step "Descobrir anexos do Drive"), que tambem DRENA a fila
-- inteira via Tika. Como a lista de arquivos vive na API do Google e a
-- credencial so existe no runner, o cockpit nao consegue descobrir o Drive
-- chamando o Edge direto (igual ao Gmail). Por isso o botao "Drive" do painel de
-- Extracao dispara este workflow on-demand.
--
-- Ate aqui so existia o AGENDAMENTO do extrator (aplicar_agendamento_extracao,
-- que (re)escreve o pg_cron). Faltava o disparo IMEDIATO. Esta RPC espelha a
-- disparar_workflow_gmail: aciona o extrair-anexos.yml via GitHub REST API
-- reusando o GITHUB_DISPATCH_TOKEN do Vault (mesmo PAT do Nomus/Gmail). Sem
-- inputs: as pastas Drive ativas e a fila inteira sao resolvidas pelo runner.
--
-- SECURITY DEFINER + acesso so service_role: chamada server-side pela Edge
-- extracao-disparar (que exige sessao autorizada + audit).
--
-- Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
-- padrao do projeto (schema_migrations remoto intencionalmente atrasado).
-- =====================================================================

create or replace function public.disparar_workflow_extracao()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_gh_url   text := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/extrair-anexos.yml/dispatches';
  v_gh_token text;
  v_req_id   bigint;
begin
  -- Segredo do Vault: PAT fine-grained (Actions RW no dlh-core), o mesmo do Nomus/Gmail.
  select decrypted_secret into v_gh_token
    from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
  if v_gh_token is null then
    raise exception 'segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
  end if;

  -- workflow_dispatch: aciona extrair-anexos.yml no branch master. Sem inputs:
  -- o runner descobre as pastas Drive ATIVAS (drive_pastas) e drena a fila.
  select net.http_post(
    url     := v_gh_url,
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_gh_token,
                 'Accept', 'application/vnd.github+json',
                 'X-GitHub-Api-Version', '2022-11-28',
                 'User-Agent', 'dlh-core-cron',
                 'Content-Type', 'application/json'
               ),
    body    := jsonb_build_object('ref', 'master')
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.disparar_workflow_extracao() is
  'Dispara manualmente o workflow GitHub Actions extrair-anexos.yml (workflow_dispatch): descobre os anexos das pastas Drive ativas e drena a fila de documentos (Tika). Usa GITHUB_DISPATCH_TOKEN do Vault. Chamada server-side pela Edge extracao-disparar.';

-- Acesso a RPC: somente service_role (a Edge extracao-disparar invoca
-- server-side). Bloqueia chamada direta por anon/authenticated.
revoke all on function public.disparar_workflow_extracao() from public, anon, authenticated;
grant execute on function public.disparar_workflow_extracao() to service_role;
