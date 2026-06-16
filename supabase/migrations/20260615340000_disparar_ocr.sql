-- =====================================================================
-- Migration: Disparo MANUAL do EXTRATOR OCR (workflow_dispatch)
--
-- O passo OCR e DEDICADO (extrair-ocr.yml, EXTRACAO_MODO=ocr): drena SO a fila
-- 'precisa_ocr' (escaneados/imagem) com OCR LIGADO e lote pequeno, separado do
-- pipeline rapido (extrair-anexos.yml, OCR off). Como OCR e caro, o disparo e
-- SEMPRE manual (cockpit ou `gh workflow run`), sem agendamento.
--
-- Espelha disparar_workflow_extracao: aciona o workflow via GitHub REST API
-- reusando o GITHUB_DISPATCH_TOKEN do Vault (mesmo PAT do Nomus/Gmail/extrator).
-- Sem inputs: o runner usa o limite padrao do workflow (50) e re-busca em loop
-- ate a fila 'precisa_ocr' esgotar ou o budget acabar.
--
-- SECURITY DEFINER + acesso so service_role: chamada server-side pela Edge
-- ocr-disparar (que exige sessao autorizada + audit).
--
-- Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
-- padrao do projeto (schema_migrations remoto intencionalmente atrasado).
-- =====================================================================

create or replace function public.disparar_workflow_ocr()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_gh_url   text := 'https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/extrair-ocr.yml/dispatches';
  v_gh_token text;
  v_req_id   bigint;
begin
  -- Segredo do Vault: PAT fine-grained (Actions RW no dlh-core), o mesmo do Nomus/Gmail.
  select decrypted_secret into v_gh_token
    from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN' limit 1;
  if v_gh_token is null then
    raise exception 'segredo GITHUB_DISPATCH_TOKEN ausente no Vault';
  end if;

  -- workflow_dispatch: aciona extrair-ocr.yml no branch master. Sem inputs:
  -- o runner usa o lote padrao (50) e drena a fila 'precisa_ocr' em loop.
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

comment on function public.disparar_workflow_ocr() is
  'Dispara manualmente o workflow GitHub Actions extrair-ocr.yml (workflow_dispatch): drena a fila de documentos status precisa_ocr com OCR ligado (Tika full). Usa GITHUB_DISPATCH_TOKEN do Vault. Chamada server-side pela Edge ocr-disparar.';

-- Acesso a RPC: somente service_role (a Edge ocr-disparar invoca server-side).
-- Bloqueia chamada direta por anon/authenticated.
revoke all on function public.disparar_workflow_ocr() from public, anon, authenticated;
grant execute on function public.disparar_workflow_ocr() to service_role;
