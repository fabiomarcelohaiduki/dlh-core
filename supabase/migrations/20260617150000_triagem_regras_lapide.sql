-- =====================================================================
-- Sprint Triagem — Migration 3/6: REGRAS DURAS e LAPIDE.
--
--   triagem_regras  -> regras duras editaveis pelo humano (termos fora de
--                      ramo ou termos que identificam produto). Schema 2.1.4.
--   triagem_lapide  -> "lapide" anti-recoleta: registra avisos descartados
--                      para nao re-coletar/re-triar o mesmo conteudo. 2.1.5.
--
-- RLS:
--   triagem_regras: SELECT/INSERT/UPDATE/DELETE = is_conta_autorizada()
--                   (o humano administra as regras pelo cockpit).
--   triagem_lapide: SELECT = is_conta_autorizada(); INSERT/UPDATE/DELETE =
--                   service_role (a esteira grava a lapide no descarte).
--
-- Trigger trg_triagem_regras_updated (BEFORE UPDATE) seta atualizado_em.
-- Idempotente: create table/index if not exists, drop ... if exists.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Funcao reutilizavel: seta atualizado_em = now() em BEFORE UPDATE.
-- ---------------------------------------------------------------------
create or replace function public.fn_set_atualizado_em()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- triagem_regras (2.1.4): regras duras editaveis.
-- ---------------------------------------------------------------------
create table if not exists public.triagem_regras (
  id            uuid primary key default gen_random_uuid(),
  tipo          text not null check (tipo in ('fora_de_ramo', 'termo_produto')),
  termo         text not null,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  criado_por    text,
  unique (tipo, termo)
);

comment on table public.triagem_regras is
  'Regras duras de triagem editaveis pelo humano: fora_de_ramo (exclui) e termo_produto (identifica produto). Aplicadas deterministicamente antes da IA.';

create index if not exists idx_triagem_regras_tipo
  on public.triagem_regras (tipo)
  where ativo = true;

drop trigger if exists trg_triagem_regras_updated on public.triagem_regras;
create trigger trg_triagem_regras_updated
  before update on public.triagem_regras
  for each row execute function public.fn_set_atualizado_em();

-- ---------------------------------------------------------------------
-- triagem_lapide (2.1.5): anti-recoleta pos descarte.
-- ---------------------------------------------------------------------
create table if not exists public.triagem_lapide (
  id             uuid primary key default gen_random_uuid(),
  aviso_id       uuid not null references public.avisos(id) on delete cascade,
  conteudo_hash  text,
  id_licitacao   numeric,
  descartado_em  timestamptz not null default now(),
  veredito_final text,
  unique (aviso_id)
);

comment on table public.triagem_lapide is
  'Lapide anti-recoleta: registra avisos descartados (por hash de conteudo e id_licitacao) para nao re-coletar/re-triar o mesmo material.';

create index if not exists idx_triagem_lapide_conteudo_hash
  on public.triagem_lapide (conteudo_hash);

-- ---------------------------------------------------------------------
-- RLS: triagem_regras (administracao humana plena).
-- ---------------------------------------------------------------------
alter table public.triagem_regras enable row level security;

drop policy if exists triagem_regras_select on public.triagem_regras;
create policy triagem_regras_select on public.triagem_regras
  for select to public
  using (public.is_conta_autorizada());

drop policy if exists triagem_regras_insert on public.triagem_regras;
create policy triagem_regras_insert on public.triagem_regras
  for insert to public
  with check (public.is_conta_autorizada());

drop policy if exists triagem_regras_update on public.triagem_regras;
create policy triagem_regras_update on public.triagem_regras
  for update to public
  using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

drop policy if exists triagem_regras_delete on public.triagem_regras;
create policy triagem_regras_delete on public.triagem_regras
  for delete to public
  using (public.is_conta_autorizada());

-- ---------------------------------------------------------------------
-- RLS: triagem_lapide (SELECT humano; escrita service_role).
-- ---------------------------------------------------------------------
alter table public.triagem_lapide enable row level security;

drop policy if exists triagem_lapide_select on public.triagem_lapide;
create policy triagem_lapide_select on public.triagem_lapide
  for select to public
  using (public.is_conta_autorizada());

drop policy if exists triagem_lapide_insert on public.triagem_lapide;
create policy triagem_lapide_insert on public.triagem_lapide
  for insert to service_role
  with check (true);

drop policy if exists triagem_lapide_update on public.triagem_lapide;
create policy triagem_lapide_update on public.triagem_lapide
  for update to service_role
  using (true) with check (true);

drop policy if exists triagem_lapide_delete on public.triagem_lapide;
create policy triagem_lapide_delete on public.triagem_lapide
  for delete to service_role
  using (true);
