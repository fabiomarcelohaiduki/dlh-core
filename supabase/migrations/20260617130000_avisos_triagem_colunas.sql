-- =====================================================================
-- Sprint Triagem — Migration 1/6: colunas de TRIAGEM na tabela avisos.
--
-- O ESTADO VIGENTE da triagem de cada aviso vive como COLUNAS na propria
-- public.avisos (Decisao 1 / Opcao A): veredito atual, confianca, quando foi
-- triado, se foi reabilitado manualmente, quando foi pra lixeira e a
-- referencia opcional para o processo Nomus vinculado. O HISTORICO e o
-- aprendizado ficam em tabelas dedicadas (triagem_decisoes / triagem_exemplos).
--
-- Tudo ADITIVO e IDEMPOTENTE (RNF-16): ADD COLUMN IF NOT EXISTS e
-- CREATE INDEX IF NOT EXISTS. Rodar duas vezes nao gera erro nem muda o
-- resultado (o ADD COLUMN e pulado por inteiro no rerun, entao os CHECKs
-- inline tambem nao sao reavaliados/duplicados).
--
-- RLS (tabela 2.2): a public.avisos JA tem RLS habilitada com a policy unica
-- do substrato (FOR ALL using/with check = is_conta_autorizada()). Isso
-- atende UPDATE = is_conta_autorizada()/service_role (service_role bypassa
-- RLS por padrao). NAO alteramos a policy existente para manter a migration
-- estritamente aditiva e nao regredir o comportamento do substrato; o DELETE
-- fisico de avisos e feito pela esteira/jobs com service_role (descarte cron).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Colunas de estado vigente da triagem.
-- ---------------------------------------------------------------------
alter table public.avisos
  add column if not exists triagem_veredito text
    check (triagem_veredito in ('lixo', 'duvida', 'util'));

alter table public.avisos
  add column if not exists triagem_confianca numeric
    check (triagem_confianca >= 0 and triagem_confianca <= 1);

alter table public.avisos
  add column if not exists triagem_em timestamptz;

alter table public.avisos
  add column if not exists reabilitado boolean not null default false;

alter table public.avisos
  add column if not exists na_lixeira_em timestamptz;

alter table public.avisos
  add column if not exists nomus_processo_ref text;

comment on column public.avisos.triagem_veredito is
  'Veredito vigente da triagem do aviso: lixo | duvida | util. NULL = ainda nao triado.';
comment on column public.avisos.triagem_confianca is
  'Confianca [0..1] do veredito vigente produzido pela IA.';
comment on column public.avisos.triagem_em is
  'Timestamp da ultima decisao de triagem que escreveu o estado vigente.';
comment on column public.avisos.reabilitado is
  'true quando um humano reabilitou manualmente o aviso (anula o descarte automatico).';
comment on column public.avisos.na_lixeira_em is
  'Timestamp em que o aviso foi enviado para a lixeira (inicia a carencia anti-descarte).';
comment on column public.avisos.nomus_processo_ref is
  'Referencia opcional ao processo Nomus correlato (ex.: nomus_id) descoberto na triagem.';

-- ---------------------------------------------------------------------
-- Indexes que alimentam fila/filtro/varredura da esteira de triagem.
--   - status_indexacao = 'indexado': fila de avisos prontos para triar.
--   - triagem_veredito: filtro por veredito no cockpit.
--   - na_lixeira = true: varredura de carencia para o descarte fisico.
-- ---------------------------------------------------------------------
create index if not exists idx_avisos_status_indexacao
  on public.avisos (status_indexacao)
  where status_indexacao = 'indexado';

create index if not exists idx_avisos_triagem_veredito
  on public.avisos (triagem_veredito);

create index if not exists idx_avisos_na_lixeira_em
  on public.avisos (na_lixeira_em)
  where na_lixeira = true;
