-- =====================================================================
-- Fonte 'drive' — pastas administraveis pelo cockpit (camada 1).
--   Ate aqui o Drive era PILOTO: a pasta vinha como input manual do workflow
--   (DRIVE_FOLDER_ID). Esta tabela torna as pastas CADASTRAVEIS: o cockpit
--   adiciona/liga/desliga pastas e o runner (descobrir-drive.mjs) le as ATIVAS
--   e descobre cada uma, sem hardcode nem redeploy.
--
--   Tabela STANDALONE de proposito (sem FK em public.fontes): a fonte Drive
--   NAO entra no ciclo de coleta do orquestrador (config_agendamento/pg_cron),
--   que so conhece Effecti/Nomus. A descoberta do Drive roda no workflow de
--   EXTRACAO (Actions), nao no ciclo de ingestao. Manter fora de `fontes`
--   evita que o orquestrador tente "coletar" o Drive.
--
--   folder_id = id natural da pasta no Google Drive (UNIQUE: a mesma pasta
--   nao se cadastra duas vezes). Os arquivos em si viram documento_vinculos
--   via descobrir_vinculos_drive — esta tabela so guarda QUAIS pastas varrer.
--
--   DDL idempotente (if not exists). RLS na policy unica do MVP.
-- =====================================================================

create table if not exists public.drive_pastas (
  id          uuid primary key default gen_random_uuid(),
  folder_id   text not null unique,           -- id natural da pasta no Drive
  nome        text not null,                  -- rotulo amigavel definido no cockpit
  ativo       boolean not null default true,  -- so as ativas sao varridas pelo runner
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

comment on table public.drive_pastas is
  'Pastas do Google Drive cadastradas no cockpit para descoberta da camada 1. Standalone (sem FK em fontes): o Drive roda no workflow de extracao, nao no ciclo de coleta.';

-- RLS: policy unica do MVP (usuario autenticado E autorizado tem acesso pleno).
-- Espelha as demais tabelas; defense in depth somado a validacao nas Edge.
alter table public.drive_pastas enable row level security;

drop policy if exists drive_pastas_acesso_autorizado on public.drive_pastas;
create policy drive_pastas_acesso_autorizado on public.drive_pastas
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());
