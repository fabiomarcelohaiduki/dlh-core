-- =====================================================================
-- Migration: Disparo MANUAL da coleta do GMAIL (workflow_dispatch)
--
-- Decisao (09/06): o Gmail e fonte de coleta+extracao (corpo do e-mail ~ aviso,
-- anexos ~ editais), mas hoje so coleta com query crua manual no workflow. O
-- card Gmail ganha um botao "Coletar e-mails agora" no cockpit, espelhando o
-- disparo do Nomus. A coleta do Gmail roda no runner Node do GitHub Actions
-- (a credencial Gmail e a API do Google so existem la), no MESMO workflow de
-- extracao (extrair-anexos.yml), acionado com o input fonte='gmail':
--   - o step "Descobrir mensagens do Gmail" monta a query pelo gmail-config
--     (data_inicial + labels) e enfileira corpo + anexos na fila de documentos;
--   - o step "Descobrir anexos do Drive" e PULADO (fonte='gmail'), entao o
--     disparo do Gmail nao varre o Drive;
--   - a extracao (Tika) drena a fila inteira normalmente (global).
--
-- A funcao roda SECURITY DEFINER e e chamada server-side pela Edge
-- gmail-disparar (que exige sessao autorizada + audit). Reusa o mesmo segredo
-- GITHUB_DISPATCH_TOKEN do Vault usado pelo disparo/agendamento do Nomus, e o
-- mesmo workflow extrair-anexos.yml ja existente (so o input fonte e novo).
--
-- Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
-- padrao do projeto (schema_migrations remoto intencionalmente atrasado).
-- =====================================================================

create or replace function public.disparar_workflow_gmail()
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
  -- Segredo do Vault: PAT fine-grained (Actions RW no dlh-core), o mesmo do Nomus.
  select decrypted_secret into v_gh_token
    from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
  if v_gh_token is null then
    raise exception 'segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
  end if;

  -- workflow_dispatch: aciona extrair-anexos.yml no branch master com
  -- fonte='gmail' (descobre so o Gmail; o Drive e pulado).
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
                 'inputs', jsonb_build_object('fonte', 'gmail')
               )
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.disparar_workflow_gmail() is
  'Dispara manualmente o workflow GitHub Actions extrair-anexos.yml (workflow_dispatch) com fonte=gmail: descobre as mensagens do Gmail (query do gmail-config) e enfileira na fila de documentos, sem varrer o Drive. Usa GITHUB_DISPATCH_TOKEN do Vault. Chamada server-side pela Edge gmail-disparar.';

-- Acesso a RPC: somente service_role (a Edge gmail-disparar invoca
-- server-side). Bloqueia chamada direta por anon/authenticated.
revoke all on function public.disparar_workflow_gmail() from public, anon, authenticated;
grant execute on function public.disparar_workflow_gmail() to service_role;
