-- =====================================================================
-- Migration: reenfileirar_coleta(p_fonte_tipo) — auto-encadeamento de blocos
--
-- Decisao (11/06): um unico disparo do agendamento deve FECHAR a janela
-- inteira sozinho, sem esperar o proximo tique diario. A coleta Effecti roda
-- UM bloco de <=5 dias por invocacao do orquestrador (limite de wall-clock do
-- Edge). Antes, so o cron avancava os blocos seguintes -> janela de 30 dias
-- levava ~6 dias para fechar (1 bloco/dia).
--
-- Esta funcao reenfileira o proprio orquestrador para o PROXIMO bloco. O Edge
-- ingestao-orquestrar a chama no fim de um bloco quando a acao foi
-- 'iniciou'/'avancou' (ainda ha blocos). Assim a coleta se encadeia ate
-- 'concluiu'. Espelha o net.http_post do job pg_cron (mesma URL, mesmo
-- segredo do Vault, mesmo body {"fonte":"<tipo>"}), mas disparado sob demanda.
--
-- Por que pg_net e nao o Edge chamar a si mesmo: pg_net e fire-and-forget pelo
-- banco -> o Edge responde rapido e o banco dispara a proxima invocacao, sem
-- aninhar Edges vivos. O single-flight por fonte do orquestrador e o checkpoint
-- atomico evitam corrida; em 'concluiu'/'ocioso'/erro a cadeia NAO reenfileira.
-- =====================================================================

create or replace function public.reenfileirar_coleta(p_fonte_tipo text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url     text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/ingestao-orquestrar';
  v_secret  text;
  v_req_id  bigint;
begin
  -- Segredo de sistema do Vault (mesmo que autentica o job pg_cron).
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
  if v_secret is null then
    raise warning 'reenfileirar_coleta: segredo CRON_DISPATCH_SECRET ausente no Vault';
    return null;
  end if;

  -- Dispara o orquestrador para o proximo bloco desta fonte (assincrono).
  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'X-Cron-Secret', v_secret
               ),
    body    := jsonb_build_object('fonte', p_fonte_tipo)
  ) into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.reenfileirar_coleta(text) is
  'Reenfileira o orquestrador para o proximo bloco da fonte (net.http_post via pg_net). Chamada pelo Edge ingestao-orquestrar quando a acao foi iniciou/avancou, encadeando os blocos ate concluir.';

-- Somente service_role: o Edge ingestao-orquestrar invoca server-side.
revoke all on function public.reenfileirar_coleta(text) from public, anon, authenticated;
grant execute on function public.reenfileirar_coleta(text) to service_role;
