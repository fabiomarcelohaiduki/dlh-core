-- =====================================================================
-- Feature Nomus Processos (secoes 2.1.2, 2.1.5 e 2.1.6 da SPEC)
-- Migration: Alteracoes ADITIVAS em config_ingestao, execucoes e
-- erros_ingestao. Preserva integralmente o schema existente do Effecti:
-- nenhuma coluna ou constraint pre-existente e removida ou quebrada; as
-- colunas legadas permanecem nullable/inalteradas (compat Effecti).
-- Toda a DDL e idempotente (add column if not exists / create index if not
-- exists) para aplicar com seguranca em base existente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- config_ingestao (secao 2.1.2): nova janela por data especifica e o mapa
-- de recursos->config (recurso->{ativo, tipos_ativos, ...}) para a fonte
-- multi-recurso Nomus (US-00/US-04/US-05). modalidades/portais legados do
-- Effecti permanecem intactos.
--   - data_inicial: date nullable default null (US-00).
--   - recursos:     jsonb NOT NULL default '{}'::jsonb (US-04/US-05).
-- ---------------------------------------------------------------------
alter table public.config_ingestao
  add column if not exists data_inicial date;

alter table public.config_ingestao
  add column if not exists recursos jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------
-- execucoes (secao 2.1.5): observabilidade multi-origem + retomada por
-- checkpoint. Colunas novas, todas opcionais, sem tocar as existentes
-- (status/etapa_atual/contadores do Effecti).
--   - fonte_id:   uuid nullable FK -> fontes(id) (origem/fonte) (RF-34).
--   - recurso:    text nullable (ex.: 'processos') (RF-34).
--   - tipo_alvo:  text nullable (ex.: 'Venda Governamental').
--   - checkpoint: jsonb NOT NULL default '{}'::jsonb (cursor de paginacao/estado) (RF-20).
-- ---------------------------------------------------------------------
alter table public.execucoes
  add column if not exists fonte_id uuid references public.fontes(id);

alter table public.execucoes
  add column if not exists recurso text;

alter table public.execucoes
  add column if not exists tipo_alvo text;

alter table public.execucoes
  add column if not exists checkpoint jsonb not null default '{}'::jsonb;

-- Indices (secao 2.1.5): fonte_id, recurso e a coluna de estado da execucao.
-- Observacao: a coluna de estado implementada nesta base e `status`
-- (schema vivo do Effecti); o indice de estado e criado sobre ela.
create index if not exists idx_execucoes_fonte_id
  on public.execucoes (fonte_id);

create index if not exists idx_execucoes_recurso
  on public.execucoes (recurso);

create index if not exists idx_execucoes_status
  on public.execucoes (status);

-- Realtime: garante que execucoes esta na publication do Supabase Realtime
-- (progresso ao vivo - US-15/RF-26). Idempotente: so adiciona se a
-- publication existir e a tabela ainda nao for membro.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'execucoes'
     )
  then
    alter publication supabase_realtime add table public.execucoes;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- erros_ingestao (secao 2.1.6): referencia generica de origem para erros
-- de qualquer fonte (nao so Effecti). aviso_id permanece nullable (ja era)
-- preservando a compat Effecti; registro_id NAO armazena payload (SEC-09).
--   - origem:      text NOT NULL default 'aviso' (ex.: 'processo-venda-governamental') (RF-34).
--   - recurso:     text nullable (ex.: 'processos').
--   - registro_id: uuid nullable (ref generica = nomus_processos.id) (SEC-09).
-- ---------------------------------------------------------------------
alter table public.erros_ingestao
  add column if not exists origem text not null default 'aviso';

alter table public.erros_ingestao
  add column if not exists recurso text;

alter table public.erros_ingestao
  add column if not exists registro_id uuid;

-- aviso_id ja e nullable no schema vivo (references avisos(id), sem NOT NULL).
-- Reforco idempotente defensivo: garante a nullabilidade exigida (compat).
alter table public.erros_ingestao
  alter column aviso_id drop not null;

-- Indices (secao 2.1.6): origem e recurso (execucao_id/aviso_id ja indexados).
create index if not exists idx_erros_ingestao_origem
  on public.erros_ingestao (origem);

create index if not exists idx_erros_ingestao_recurso
  on public.erros_ingestao (recurso);
