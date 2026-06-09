-- =====================================================================
-- Fonte 'gmail' — configuracao administravel pelo cockpit (camada 1).
--   Espelha o par drive_conta/drive_pastas, mas a semantica das labels e
--   INVERTIDA (decisao Fabio 2026-06-09): em vez de cadastrar O QUE incluir,
--   cadastram-se labels a EXCLUIR (blacklist). O runner coleta tudo a partir
--   da data e remove da query os emails marcados com essas labels.
--
--   gmail_config = SINGLETON (id boolean = true). Guarda a data inicial da
--                  coleta (default 2026-05-01, configuravel no cockpit). O
--                  runner monta a query Gmail `after:<data> -label:"X" ...`.
--   gmail_labels = labels a EXCLUIR. Cada linha = uma label (nome como aparece
--                  no Gmail). So as ativas entram na query como `-label:"nome"`.
--
--   STANDALONE (sem FK em public.fontes): igual ao Drive, a fonte Gmail NAO
--   entra no ciclo de coleta do orquestrador (pg_cron so conhece Effecti/
--   Nomus). A coleta/descoberta do Gmail roda no workflow de extracao (Actions).
--
--   DDL idempotente (if not exists). RLS na policy unica do MVP.
-- =====================================================================

-- Config singleton da coleta Gmail. id=true garante linha unica.
create table if not exists public.gmail_config (
  id            boolean primary key default true check (id),
  data_inicial  date not null default date '2026-05-01',   -- coleta emails a partir desta data
  atualizado_em timestamptz not null default now()
);

comment on table public.gmail_config is
  'Singleton: parametros da coleta Gmail (data inicial). O runner monta a query a partir daqui + gmail_labels (blacklist).';

-- Semente da linha singleton (idempotente).
insert into public.gmail_config (id) values (true)
on conflict (id) do nothing;

-- Labels a EXCLUIR da coleta (blacklist). O nome e como aparece no Gmail.
create table if not exists public.gmail_labels (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique,            -- nome da label no Gmail (ex.: "Promoções")
  nome        text,                            -- rotulo amigavel opcional (default = label)
  ativo       boolean not null default true,   -- so as ativas entram na query como -label:"..."
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

comment on table public.gmail_labels is
  'Labels do Gmail a EXCLUIR da coleta (blacklist). So as ativas viram -label:"nome" na query do runner.';

-- RLS: policy unica do MVP (usuario autenticado E autorizado tem acesso pleno).
alter table public.gmail_config enable row level security;
drop policy if exists gmail_config_acesso_autorizado on public.gmail_config;
create policy gmail_config_acesso_autorizado on public.gmail_config
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

alter table public.gmail_labels enable row level security;
drop policy if exists gmail_labels_acesso_autorizado on public.gmail_labels;
create policy gmail_labels_acesso_autorizado on public.gmail_labels
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());
