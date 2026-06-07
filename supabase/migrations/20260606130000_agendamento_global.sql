-- =====================================================================
-- Migration: Agendamento GLOBAL + orquestracao sequencial de fontes
--
-- Decisao de design (06/06): em vez de um cron por fonte (que se sobrepoem
-- e, pelo anti-duplo-disparo global, fazem a 2a coleta tomar 409 e se
-- perder), adota-se UM relogio global. A cada tique, um orquestrador
-- percorre as fontes ATIVAS, em ORDEM, e coleta uma de cada vez.
--
-- Este migration cria apenas o SUBSTRATO DE DADOS:
--   1. config_agendamento (singleton): frequencia/horario do ciclo global.
--   2. fontes.ativa / fontes.ordem: quais fontes entram no ciclo e em que ordem.
-- A reescrita do pg_cron e o disparo real ficam em migration/funcao proprias.
-- =====================================================================

-- ---------------------------------------------------------------------
-- config_agendamento — relogio global do ciclo de coleta (singleton).
-- horario_referencia em HH:MM no fuso America/Sao_Paulo (UTC-3 fixo, o
-- Brasil nao tem mais horario de verao); o tradutor converte para UTC ao
-- montar a expressao cron. frequencia governa o passo do ciclo.
-- ---------------------------------------------------------------------
create table if not exists public.config_agendamento (
  id                  uuid primary key default gen_random_uuid(),
  ativo               boolean not null default false,        -- liga/desliga o ciclo automatico
  frequencia          text not null default 'manual',        -- 'manual'|'horaria'|'diaria'|'semanal'|'mensal'
  horario_referencia  text,                                  -- 'HH:MM' local (America/Sao_Paulo)
  dia_semana          int,                                   -- 0-6 (semanal); null nos demais
  dia_mes             int,                                   -- 1-28 (mensal); null nos demais
  timezone            text not null default 'America/Sao_Paulo',
  updated_at          timestamptz default now()
);

-- Singleton: garante no maximo uma linha de configuracao do ciclo.
create unique index if not exists uq_config_agendamento_singleton
  on public.config_agendamento ((true));

-- Linha inicial: ciclo DESLIGADO ate o Fabio configurar pelo painel.
insert into public.config_agendamento (ativo, frequencia, horario_referencia)
select false, 'manual', '07:00'
where not exists (select 1 from public.config_agendamento);

-- ---------------------------------------------------------------------
-- fontes.ativa / fontes.ordem — participacao e ordem no ciclo global.
-- ativa=true  => entra no ciclo automatico do orquestrador.
-- ordem ASC   => sequencia de coleta (Effecti primeiro = menor ordem).
-- ---------------------------------------------------------------------
alter table public.fontes
  add column if not exists ativa boolean not null default true;

alter table public.fontes
  add column if not exists ordem int not null default 0;

-- ---------------------------------------------------------------------
-- RLS: mesma policy unica do MVP (acesso pleno para conta autorizada).
-- Espelha o padrao das demais tabelas (20260606120300_rls.sql).
-- ---------------------------------------------------------------------
alter table public.config_agendamento enable row level security;
create policy config_agendamento_acesso_autorizado on public.config_agendamento
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());
