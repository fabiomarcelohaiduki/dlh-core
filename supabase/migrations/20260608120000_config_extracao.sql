-- =====================================================================
-- Migration: config_extracao — parametros da camada 1 do extrator.
--   Camada 1 = extracao de TEXTO PURO (Tika + decode Node), deterministica,
--   ZERO LLM. Roda no runner Node (.github/scripts/extrator.mjs), que LE
--   esta config no inicio do job. Administravel pelo cockpit, sem hardcode.
--   (segue o padrao de config_ingestao: RLS por conta autorizada,
--    trigger updated_at, audit_log, seed idempotente)
--
--   Singleton GLOBAL (uma linha): o extrator e agnostico de fonte, entao
--   os parametros valem para Nomus, Effecti, Drive, Gmail igualmente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabela: config_extracao
--   ocr_estrategia      'auto' | 'nunca' | 'sempre' (mapeia no Tika para
--                       no_ocr / auto / ocr_and_text)
--   ocr_idioma          codigos Tesseract, ex 'por+eng'
--   tamanho_max_bytes   limite por arquivo; acima => pula (ExtracaoError)
--   timeout_ms          timeout por arquivo na chamada ao Tika
--   extensoes_habilitadas  null = todas; array = allowlist
--   lote_tamanho        quantos arquivos por lote antes da pausa
--   pausa_lote_ms       pausa entre lotes (alivia o servico Tika)
-- ---------------------------------------------------------------------
create table public.config_extracao (
  id                     uuid primary key default gen_random_uuid(),
  ocr_estrategia         text not null default 'auto',
  ocr_idioma             text not null default 'por+eng',
  tamanho_max_bytes      bigint not null default 104857600,   -- 100 MiB
  timeout_ms             int not null default 120000,
  extensoes_habilitadas  text[],                              -- null = todas
  lote_tamanho           int not null default 10,
  pausa_lote_ms          int not null default 0,
  updated_at             timestamptz,
  constraint config_extracao_ocr_estrategia_chk
    check (ocr_estrategia in ('auto', 'nunca', 'sempre'))
);

-- ---------------------------------------------------------------------
-- RLS: mesmo gate de config_ingestao (conta autorizada).
-- ---------------------------------------------------------------------
alter table public.config_extracao enable row level security;
create policy config_extracao_acesso_autorizado on public.config_extracao
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- ---------------------------------------------------------------------
-- Triggers: audit_log + updated_at (reusa funcoes existentes).
-- ---------------------------------------------------------------------
create trigger trg_audit_config_extracao
  after insert or update or delete on public.config_extracao
  for each row execute function public.fn_audit_log();

create trigger trg_set_updated_at_config_extracao
  before update on public.config_extracao
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------
-- Seed: 1 linha default (singleton). Idempotente — re-aplicar nao duplica.
-- ---------------------------------------------------------------------
insert into public.config_extracao
  (ocr_estrategia, ocr_idioma, tamanho_max_bytes, timeout_ms, extensoes_habilitadas, lote_tamanho, pausa_lote_ms)
select 'auto', 'por+eng', 104857600, 120000, null, 10, 0
where not exists (select 1 from public.config_extracao);
