-- =====================================================================
-- Sprint Triagem — Migration 2/6: HISTORICO e APRENDIZADO.
--
--   triagem_decisoes  -> historico auditavel, 1 linha por rodada de decisao
--                        da IA (com feedback humano opcional). Schema 2.1.2.
--   triagem_exemplos  -> banco few-shot rotulado (texto + veredito humano +
--                        embedding) usado para ancorar a IA. Schema 2.1.3.
--
-- RLS deny-by-default (policies por operacao):
--   triagem_decisoes: SELECT = is_conta_autorizada(); INSERT/UPDATE/DELETE
--                     = service_role (a esteira/IA escreve; o humano so le).
--   triagem_exemplos: SELECT = is_conta_autorizada(); INSERT = service_role
--                     (pipeline gera embedding); UPDATE/DELETE =
--                     is_conta_autorizada() (curadoria humana do few-shot).
--   service_role bypassa RLS (BYPASSRLS); as policies "to service_role"
--   documentam a intencao e mantem o deny-by-default para anon/authenticated.
--
-- NAO expor em views lia.* (SEC-3); nenhum GRANT a role lia_sql.
-- Tudo idempotente: create table/index if not exists, drop policy if exists.
-- =====================================================================

-- ---------------------------------------------------------------------
-- triagem_decisoes (2.1.2): historico auditavel por rodada.
-- ---------------------------------------------------------------------
create table if not exists public.triagem_decisoes (
  id                      uuid primary key default gen_random_uuid(),
  aviso_id                uuid not null references public.avisos(id) on delete cascade,
  veredito                text not null check (veredito in ('lixo', 'duvida', 'util')),
  confianca               numeric check (confianca >= 0 and confianca <= 1),
  motivo                  text,
  produto_candidato_id    uuid,
  produto_candidato_nome  text,
  feedback_humano         text check (feedback_humano in ('correto', 'incorreto')),
  feedback_por            text,
  feedback_em             timestamptz,
  decidido_em             timestamptz not null default now(),
  decidido_por            text not null default 'lia',
  agente_versao           int
);

comment on table public.triagem_decisoes is
  'Historico auditavel da triagem: 1 linha por rodada de decisao da IA, com feedback humano opcional. Estado vigente fica em avisos.';

create index if not exists idx_triagem_decisoes_aviso
  on public.triagem_decisoes (aviso_id);

create index if not exists idx_triagem_decisoes_decidido_em
  on public.triagem_decisoes (decidido_em desc);

-- ---------------------------------------------------------------------
-- triagem_exemplos (2.1.3): few-shot rotulado com embedding.
-- ---------------------------------------------------------------------
create table if not exists public.triagem_exemplos (
  id                uuid primary key default gen_random_uuid(),
  aviso_id          uuid references public.avisos(id) on delete set null,
  decisao_id        uuid references public.triagem_decisoes(id) on delete set null,
  texto             text not null,
  veredito_rotulado text check (veredito_rotulado in ('lixo', 'duvida', 'util')),
  embedding         vector(1024),
  ativo             boolean not null default true,
  criado_em         timestamptz not null default now()
);

comment on table public.triagem_exemplos is
  'Banco few-shot rotulado (texto + veredito humano + embedding) para ancorar a IA na triagem. Curado por humanos; ativo=false aposenta o exemplo.';

-- Acervo few-shot pequeno => lists baixo (sqrt(N) ~ unidades). Index parcial
-- espelha o predicado de leitura (ativo=true) do recuperador de exemplos.
create index if not exists idx_triagem_exemplos_embedding
  on public.triagem_exemplos
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 4)
  where ativo = true;

create index if not exists idx_triagem_exemplos_criado_em
  on public.triagem_exemplos (criado_em desc);

-- ---------------------------------------------------------------------
-- RLS: triagem_decisoes (SELECT humano; escrita service_role).
-- ---------------------------------------------------------------------
alter table public.triagem_decisoes enable row level security;

drop policy if exists triagem_decisoes_select on public.triagem_decisoes;
create policy triagem_decisoes_select on public.triagem_decisoes
  for select to public
  using (public.is_conta_autorizada());

drop policy if exists triagem_decisoes_insert on public.triagem_decisoes;
create policy triagem_decisoes_insert on public.triagem_decisoes
  for insert to service_role
  with check (true);

drop policy if exists triagem_decisoes_update on public.triagem_decisoes;
create policy triagem_decisoes_update on public.triagem_decisoes
  for update to service_role
  using (true) with check (true);

drop policy if exists triagem_decisoes_delete on public.triagem_decisoes;
create policy triagem_decisoes_delete on public.triagem_decisoes
  for delete to service_role
  using (true);

-- ---------------------------------------------------------------------
-- RLS: triagem_exemplos (SELECT + curadoria humana; INSERT service_role).
-- ---------------------------------------------------------------------
alter table public.triagem_exemplos enable row level security;

drop policy if exists triagem_exemplos_select on public.triagem_exemplos;
create policy triagem_exemplos_select on public.triagem_exemplos
  for select to public
  using (public.is_conta_autorizada());

drop policy if exists triagem_exemplos_insert on public.triagem_exemplos;
create policy triagem_exemplos_insert on public.triagem_exemplos
  for insert to service_role
  with check (true);

drop policy if exists triagem_exemplos_update on public.triagem_exemplos;
create policy triagem_exemplos_update on public.triagem_exemplos
  for update to public
  using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

drop policy if exists triagem_exemplos_delete on public.triagem_exemplos;
create policy triagem_exemplos_delete on public.triagem_exemplos
  for delete to public
  using (public.is_conta_autorizada());
