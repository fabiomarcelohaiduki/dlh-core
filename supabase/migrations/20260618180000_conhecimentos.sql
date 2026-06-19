-- =====================================================================
-- Base de Conhecimento (generica, multi-setor) — SPEC-base-conhecimento.md
--
--   public.conhecimentos -> conhecimento de dominio administravel no cockpit,
--   versionado e auditado, entregue pela FILA ao subagente (1x no topo, nao por
--   item). Generico por `setor` (licitacao hoje; fiscal/comercial depois) sem
--   rewrite. Curadoria HUMANA (nao pipeline): INSERT/UPDATE/DELETE pelo humano
--   autorizado; a fila so LE (service_role).
--
-- Persona segue singleton em triagem_agente_config (nao tocada). A chave `setor`
-- e plantada aqui para a persona generalizar no 2o subagente sem rewrite.
--
-- RLS deny-by-default (espelha triagem_*): SELECT = is_conta_autorizada();
-- escrita = is_conta_autorizada() (curadoria). service_role bypassa (BYPASSRLS)
-- para a fila ler. NAO expor em views lia.* (SEC-3); nenhum GRANT a lia_sql.
-- Tudo idempotente: create if not exists, drop policy if exists, create or replace.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabela
-- ---------------------------------------------------------------------
create table if not exists public.conhecimentos (
  id              uuid primary key default gen_random_uuid(),
  setor           text not null,
  titulo          text not null,
  conteudo        text not null,
  ativo           boolean not null default true,
  ordem           int not null default 0,
  versao          int not null default 1,
  atualizado_por  text,
  atualizado_em   timestamptz,
  criado_em       timestamptz not null default now()
);

comment on table public.conhecimentos is
  'Conhecimento de dominio por setor, administravel no cockpit e entregue pela FILA ao subagente. Versionado (trigger) e auditado na Edge. Curadoria humana; a fila so le.';

-- Predicado de leitura da fila: setor + ativo, ordenado por ordem.
create index if not exists idx_conhecimentos_setor_ativo_ordem
  on public.conhecimentos (setor, ativo, ordem);

-- ---------------------------------------------------------------------
-- Trigger de versao: incrementa `versao` e seta `atualizado_em` no UPDATE.
-- Espelha trg_triagem_agente_config_updated.
-- ---------------------------------------------------------------------
create or replace function public.tg_conhecimentos_updated()
returns trigger
language plpgsql
as $$
begin
  new.versao := coalesce(old.versao, 0) + 1;
  new.atualizado_em := now();
  return new;
end;
$$;

drop trigger if exists trg_conhecimentos_updated on public.conhecimentos;
create trigger trg_conhecimentos_updated
  before update on public.conhecimentos
  for each row
  execute function public.tg_conhecimentos_updated();

-- ---------------------------------------------------------------------
-- RLS: SELECT humano (+ service_role bypassa p/ a fila); escrita = curadoria.
-- ---------------------------------------------------------------------
alter table public.conhecimentos enable row level security;

drop policy if exists conhecimentos_select on public.conhecimentos;
create policy conhecimentos_select on public.conhecimentos
  for select to public
  using (public.is_conta_autorizada());

drop policy if exists conhecimentos_insert on public.conhecimentos;
create policy conhecimentos_insert on public.conhecimentos
  for insert to public
  with check (public.is_conta_autorizada());

drop policy if exists conhecimentos_update on public.conhecimentos;
create policy conhecimentos_update on public.conhecimentos
  for update to public
  using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

drop policy if exists conhecimentos_delete on public.conhecimentos;
create policy conhecimentos_delete on public.conhecimentos
  for delete to public
  using (public.is_conta_autorizada());
