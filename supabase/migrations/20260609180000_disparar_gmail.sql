-- =====================================================================
-- Migration: Disparo MANUAL da coleta do GMAIL (workflow_dispatch)
--
-- Decisao (09/06): o Gmail e fonte de coleta+extracao (corpo do e-mail ~ aviso,
-- anexos ~ editais). A COLETA do Gmail e INDEPENDENTE da extracao (decisao
-- Fabio 2026-06-09: cada fonte coleta no seu proprio workflow; a extracao drena
-- a fila por conta propria). O card Gmail tem um botao "Coletar e-mails agora"
-- no cockpit, espelhando o disparo do Nomus.
--
-- A coleta roda no runner Node do GitHub Actions (a credencial Gmail e a API do
-- Google so existem la), no workflow PROPRIO coletar-gmail.yml:
--   - monta a query pelo gmail-config (data_inicial + labels) e enfileira
--     corpo + anexos na fila de documentos (descobrir-gmail.mjs);
--   - NAO usa Tika e NAO toca no Drive (workflow leve, so produtor da fila).
-- A extracao (Tika) e o workflow SEPARADO extrair-anexos.yml, que consome a
-- fila independentemente. Concurrency groups distintos => coleta do Gmail nao
-- espera nem barra a extracao.
--
-- A funcao roda SECURITY DEFINER e e chamada server-side pela Edge
-- gmail-disparar (que exige sessao autorizada + audit). Reusa o mesmo segredo
-- GITHUB_DISPATCH_TOKEN do Vault usado pelo disparo/agendamento do Nomus.
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
  v_gh_url   text := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-gmail.yml/dispatches';
  v_gh_token text;
  v_req_id   bigint;
begin
  -- Segredo do Vault: PAT fine-grained (Actions RW no dlh-core), o mesmo do Nomus.
  select decrypted_secret into v_gh_token
    from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
  if v_gh_token is null then
    raise exception 'segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
  end if;

  -- workflow_dispatch: aciona coletar-gmail.yml no branch master (a query e
  -- montada pelo gmail-config no runner; sem inputs aqui).
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

comment on function public.disparar_workflow_gmail() is
  'Dispara manualmente o workflow GitHub Actions coletar-gmail.yml (workflow_dispatch): descobre as mensagens do Gmail (query do gmail-config) e enfileira na fila de documentos, independente da extracao. Usa GITHUB_DISPATCH_TOKEN do Vault. Chamada server-side pela Edge gmail-disparar.';

-- Acesso a RPC: somente service_role (a Edge gmail-disparar invoca
-- server-side). Bloqueia chamada direta por anon/authenticated.
revoke all on function public.disparar_workflow_gmail() from public, anon, authenticated;
grant execute on function public.disparar_workflow_gmail() to service_role;
