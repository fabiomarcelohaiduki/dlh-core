-- =====================================================================
-- Sprint Triagem — Migration 4/6: CONFIGS SINGLETON + TRIGGERS + SEED.
--
--   config_automacao       -> parametros operacionais da automacao de triagem
--                             (carencia, limiares de confianca, k few-shot,
--                             switch de descarte fisico, modo de execucao da
--                             IA). Singleton. Schema/triggers 2.3.
--   triagem_agente_config  -> persona/ferramentas/versao do agente de triagem.
--                             Singleton com versionamento automatico. 2.3.
--
-- Singleton garantido em camada dupla:
--   (1) coluna `singleton boolean UNIQUE CHECK (singleton = true)` -> como todas
--       as linhas tem singleton=true, o UNIQUE limita a no maximo 1 linha;
--   (2) trigger BEFORE INSERT (fn_singleton_guard) que recusa uma 2a linha.
--
-- RLS: SELECT/UPDATE = is_conta_autorizada(); INSERT = service_role; DELETE
-- NEGADO (sem policy de delete => deny-by-default; singleton nunca e apagado).
--
-- Seed idempotente via INSERT ... SELECT ... WHERE NOT EXISTS (no rerun nao
-- produz linha alguma, entao nem dispara o guard de singleton).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Guard generico de singleton: recusa INSERT se ja existe >= 1 linha.
-- ---------------------------------------------------------------------
create or replace function public.fn_singleton_guard()
returns trigger
language plpgsql
as $$
declare
  v_count bigint;
begin
  execute format('select count(*) from public.%I', tg_table_name) into v_count;
  if v_count > 0 then
    raise exception 'Tabela % e singleton: ja existe uma linha (insercao recusada).', tg_table_name;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- config_automacao (2.3): singleton de parametros da automacao.
-- ---------------------------------------------------------------------
create table if not exists public.config_automacao (
  id                      uuid primary key default gen_random_uuid(),
  singleton               boolean not null default true unique check (singleton = true),
  dias_carencia           int not null default 30 check (dias_carencia between 1 and 365),
  limiar_inferior         numeric not null default 0.35 check (limiar_inferior >= 0 and limiar_inferior <= 1),
  limiar_superior         numeric not null default 0.55 check (limiar_superior >= 0 and limiar_superior <= 1),
  k_few_shot              int not null default 8 check (k_few_shot between 0 and 50),
  descarte_fisico_ligado  boolean not null default false,
  modo_execucao_ia        text not null default 'lion' check (modo_execucao_ia in ('lion', 'autonoma')),
  atualizado_em           timestamptz not null default now(),
  atualizado_por          text,
  check (limiar_inferior <= limiar_superior)
);

comment on table public.config_automacao is
  'Singleton: parametros operacionais da automacao de triagem (carencia, limiares de confianca, k few-shot, descarte fisico, modo de execucao da IA).';

-- ---------------------------------------------------------------------
-- triagem_agente_config (2.3): singleton de persona/ferramentas do agente.
-- ---------------------------------------------------------------------
create table if not exists public.triagem_agente_config (
  id             uuid primary key default gen_random_uuid(),
  singleton      boolean not null default true unique check (singleton = true),
  ativo          boolean not null default true,
  nome           text not null default 'Especialista em Avisos',
  persona_prompt text not null,
  ferramentas    text[] not null default '{}',
  versao         int not null default 1,
  atualizado_em  timestamptz not null default now(),
  atualizado_por text
);

comment on table public.triagem_agente_config is
  'Singleton: configuracao do agente de triagem (persona_prompt, ferramentas habilitadas, versao auto-incrementada a cada update).';

-- ---------------------------------------------------------------------
-- Funcao de updated/versao do agente: seta atualizado_em e incrementa versao.
-- ---------------------------------------------------------------------
create or replace function public.fn_triagem_agente_config_updated()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em := now();
  new.versao := coalesce(old.versao, 0) + 1;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Triggers (2.3).
-- ---------------------------------------------------------------------
drop trigger if exists trg_config_automacao_updated on public.config_automacao;
create trigger trg_config_automacao_updated
  before update on public.config_automacao
  for each row execute function public.fn_set_atualizado_em();

drop trigger if exists trg_config_automacao_singleton on public.config_automacao;
create trigger trg_config_automacao_singleton
  before insert on public.config_automacao
  for each row execute function public.fn_singleton_guard();

drop trigger if exists trg_triagem_agente_config_updated on public.triagem_agente_config;
create trigger trg_triagem_agente_config_updated
  before update on public.triagem_agente_config
  for each row execute function public.fn_triagem_agente_config_updated();

drop trigger if exists trg_triagem_agente_config_singleton on public.triagem_agente_config;
create trigger trg_triagem_agente_config_singleton
  before insert on public.triagem_agente_config
  for each row execute function public.fn_singleton_guard();

-- ---------------------------------------------------------------------
-- RLS: SELECT/UPDATE humano; INSERT service_role; DELETE negado.
-- ---------------------------------------------------------------------
alter table public.config_automacao enable row level security;

drop policy if exists config_automacao_select on public.config_automacao;
create policy config_automacao_select on public.config_automacao
  for select to public
  using (public.is_conta_autorizada());

drop policy if exists config_automacao_update on public.config_automacao;
create policy config_automacao_update on public.config_automacao
  for update to public
  using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

drop policy if exists config_automacao_insert on public.config_automacao;
create policy config_automacao_insert on public.config_automacao
  for insert to service_role
  with check (true);

alter table public.triagem_agente_config enable row level security;

drop policy if exists triagem_agente_config_select on public.triagem_agente_config;
create policy triagem_agente_config_select on public.triagem_agente_config
  for select to public
  using (public.is_conta_autorizada());

drop policy if exists triagem_agente_config_update on public.triagem_agente_config;
create policy triagem_agente_config_update on public.triagem_agente_config
  for update to public
  using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

drop policy if exists triagem_agente_config_insert on public.triagem_agente_config;
create policy triagem_agente_config_insert on public.triagem_agente_config
  for insert to service_role
  with check (true);

-- ---------------------------------------------------------------------
-- Seed idempotente (singleton). WHERE NOT EXISTS => rerun nao insere nada.
-- ---------------------------------------------------------------------
insert into public.config_automacao (
  singleton, dias_carencia, limiar_inferior, limiar_superior,
  k_few_shot, descarte_fisico_ligado, modo_execucao_ia
)
select true, 30, 0.35, 0.55, 8, false, 'lion'
where not exists (select 1 from public.config_automacao);

insert into public.triagem_agente_config (
  singleton, ativo, nome, persona_prompt, ferramentas, versao
)
select
  true,
  true,
  'Especialista em Avisos',
  'Voce e um especialista senior em triagem de avisos/editais de licitacao da DLH. '
    || 'Sua missao e classificar cada aviso em util, duvida ou lixo, com base no ramo de '
    || 'atuacao da empresa e no catalogo de produtos. Use as regras duras antes de decidir, '
    || 'recupere trechos relevantes do aviso e busque produtos candidatos. Seja conservador: '
    || 'na incerteza, classifique como duvida. Justifique sempre o veredito de forma objetiva.',
  '{busca_produtos,recuperar_trechos,aplicar_regras_duras}'::text[],
  1
where not exists (select 1 from public.triagem_agente_config);
