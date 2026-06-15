-- =====================================================================
-- Migration: AUTO-RETRY contínuo da INDEXACAO (embeddings).
--
--   PROBLEMA: o `erro` da indexacao era estado TERMINAL — uma falha (quase
--   sempre 429/timeout TRANSITORIO da OpenAI sob burst) marcava o doc 'erro'
--   e ninguem mais o tentava. Reprocessar era 100% manual (botao no cockpit).
--   Alem disso NAO ha cron de indexacao: o backfill so anda pela cadeia
--   pg_net (reenfileirar_indexacao); se a cadeia morre no meio (wall-clock
--   do Edge), a fila CONGELA ate alguem disparar de novo.
--
--   FIX (automatico + continuo, sem hardcode):
--     (1) coluna documentos.tentativas_indexacao (conta as falhas do doc).
--     (2) config_indexacao.tentativas_max (teto, default 3; administravel).
--     (3) marcar_falha_indexacao(id, teto): no catch do Edge, incrementa
--         tentativas e RE-MARCA 'pendente' enquanto < teto (a cadeia drena
--         pendente sozinha -> reprocesso transparente); so vira 'erro'
--         DEFINITIVO ao atingir o teto. Transitorio se cura sozinho; 'erro'
--         na barra = problema real (anexo sumiu, doc corrompido).
--     (4) cron de seguranca `indexacao-kick` (*/10 min): se o master switch
--         esta ON e ainda ha pendente, reabre a cadeia. No-op (custo zero)
--         com fila vazia ou switch OFF. E o marca-passo: mesmo que a cadeia
--         pg_net morra, o cron a religa no proximo tique. Idempotente.
--
--   Idempotente: add column if not exists / create or replace / cron.schedule
--   substitui job de mesmo nome. Aplicar via Node `pg` (SUPABASE_DB_URL),
--   padrao do projeto (NUNCA supabase db push).
-- =====================================================================

-- ---------------------------------------------------------------------
-- (1) Contador de tentativas por documento.
-- ---------------------------------------------------------------------
alter table public.documentos
  add column if not exists tentativas_indexacao int not null default 0;

-- ---------------------------------------------------------------------
-- (2) Teto de tentativas administravel (singleton config_indexacao).
-- ---------------------------------------------------------------------
alter table public.config_indexacao
  add column if not exists tentativas_max int not null default 3;

-- ---------------------------------------------------------------------
-- (3) marcar_falha_indexacao — incrementa tentativas e decide o destino.
--     < teto -> volta 'pendente' (reprocesso automatico pela cadeia).
--     >= teto -> 'erro' DEFINITIVO (so o reprocesso manual reabre).
--     NAO toca `texto` (nao dispara trg_set_texto_chars). Retorna o status
--     resultante para log do Edge.
-- ---------------------------------------------------------------------
create or replace function public.marcar_falha_indexacao(
  p_id   uuid,
  p_teto int
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  update public.documentos d
  set tentativas_indexacao = coalesce(d.tentativas_indexacao, 0) + 1,
      status_indexacao = case
        when coalesce(d.tentativas_indexacao, 0) + 1 >= greatest(p_teto, 1)
          then 'erro'
        else 'pendente'
      end
  where d.id = p_id
  returning d.status_indexacao into v_status;
  return v_status;
end;
$$;

comment on function public.marcar_falha_indexacao(uuid, int) is
  'Registra uma falha de indexacao do documento: incrementa tentativas_indexacao e re-marca pendente enquanto abaixo do teto (auto-retry pela cadeia), ou erro definitivo ao atingir o teto. Retorna o status resultante.';

revoke all on function public.marcar_falha_indexacao(uuid, int) from public, anon, authenticated;
grant execute on function public.marcar_falha_indexacao(uuid, int) to service_role;

-- ---------------------------------------------------------------------
-- (4) Cron de seguranca: marca-passo que reabre a cadeia se ela parar.
--     So dispara com master switch ON e fila com pendente; senao no-op.
-- ---------------------------------------------------------------------
select cron.schedule(
  'indexacao-kick',
  '*/10 * * * *',
  $cron$
    select public.reenfileirar_indexacao()
    where coalesce((select ativo from public.config_indexacao limit 1), false)
      and public.tem_documento_pendente_indexacao(null);
  $cron$
);
