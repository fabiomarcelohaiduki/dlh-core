-- =====================================================================
-- Migration: a re-varredura FULL de processos passa a ser editavel pelo
-- cockpit (guia Coleta > Agendamento), como os demais relogios de coleta.
--
-- MOTIVO (28/06): a migration 160100 criou o cron 'coleta-nomus-processos-full'
-- com cadencia HARDCODE ('0 6 * * *' = 03:00 BRT). O Fabio quer controlar essa
-- cadencia pelo cockpit (frequencia/horario/liga-desliga), sem hardcode.
--
-- COMO: o agendamento da re-varredura vira o pseudo-recurso 'processos-full'
-- dentro de config_ingestao.recursos (jsonb). O endpoint /agendamento-fonte-config
-- ja sabe gravar recursos.<recurso>.agendamento e chamar
-- aplicar_agendamento_recurso('nomus','processos-full'), que GENERICAMENTE monta
-- o job 'coleta-nomus-processos-full' enfileirando 'nomus-processos-full' (mesmo
-- nome de job e mesmo comando da 160100). Nenhuma mudanca na RPC e necessaria.
--
-- O QUE ESTA MIGRATION FAZ (idempotente):
--   1. Faz SEED do agendamento em config_ingestao.recursos['processos-full'] com
--      a cadencia que hoje esta viva (diaria 03:00, ligada), para o card do
--      cockpit refletir o estado real e NAO matar o cron ao salvar.
--   2. Chama aplicar_agendamento_recurso('nomus','processos-full') para o cron
--      passar a ser DERIVADO da config (a 160100 cravava direto; agora o relogio
--      e dono do cockpit). Mesmo job, mesma expressao, agora editavel.
--
-- Aplicar via Node `pg` (SUPABASE_DB_URL), padrao do projeto (db push quebrado).
-- =====================================================================

-- Seed do agendamento do pseudo-recurso, preservando os demais campos de
-- recursos. jsonb_set so cria o ELEMENTO FINAL ausente, nao chaves
-- intermediarias: como a chave 'processos-full' ainda nao existe em recursos,
-- escrevemos no nivel TOP ('{processos-full}', que o root permite criar) com o
-- valor = (processos-full existente, ou {}) || { agendamento } — assim cria a
-- chave e preserva eventuais subcampos de processos-full.
update public.config_ingestao c
   set recursos = jsonb_set(
         coalesce(c.recursos, '{}'::jsonb),
         '{processos-full}',
         coalesce(c.recursos -> 'processos-full', '{}'::jsonb)
           || jsonb_build_object(
                'agendamento',
                jsonb_build_object(
                  'ativo', true,
                  'frequencia', 'diaria',
                  'horario_referencia', '03:00',
                  'dia_semana', null,
                  'dia_mes', null
                )
              ),
         true
       ),
       updated_at = now()
  from public.fontes f
 where f.tipo = 'nomus'
   and c.fonte_id = f.id
   -- So semeia se ainda nao houver agendamento de processos-full (idempotente:
   -- nao sobrescreve uma cadencia que o Fabio ja tenha editado pelo cockpit).
   and (c.recursos #> '{processos-full,agendamento}') is null;

-- Reescreve o cron a partir da config recem-semeada (vira config-driven).
select public.aplicar_agendamento_recurso('nomus', 'processos-full');
