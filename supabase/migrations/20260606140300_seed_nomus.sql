-- =====================================================================
-- Feature Nomus Processos (secao 2.4 da SPEC - US-00)
-- Migration: Seed idempotente da fonte Nomus.
--
-- Estende o seed existente (que so cria a fonte Effecti) inserindo, de forma
-- idempotente, a fonte Nomus e sua config_ingestao com o mapa de recursos
-- default. NENHUM novo agendador e criado: config_agendamento (singleton)
-- permanece com a linha existente (RF-30).
--
-- Idempotencia: re-executar a migration NAO duplica nem falha (guards por
-- "where not exists" na chave natural tipo='nomus").
-- =====================================================================

-- ---------------------------------------------------------------------
-- fontes: linha semente da fonte Nomus (US-00).
--   - endpoint_base: URL base da instancia Nomus (coluna NOT NULL, jamais
--     nula/vazia). AJUSTAR para a URL real da instancia em producao.
--   - estado_conexao='nao_configurada', token_cifrado=null (credencial sera
--     gravada no Vault via cockpit), ativa=true, ordem=2 (Effecti=0 vem antes
--     no ciclo global sequencial).
-- ---------------------------------------------------------------------
insert into public.fontes (nome, tipo, endpoint_base, estado_conexao, token_cifrado, ativa, ordem)
select 'Nomus', 'nomus', 'https://famaha.nomus.com.br/famaha', 'nao_configurada', null, true, 2
where not exists (
  select 1 from public.fontes where tipo = 'nomus'
);

-- ---------------------------------------------------------------------
-- config_ingestao: default da fonte Nomus (US-00/US-04/US-05).
--   - janela_dias=7, data_inicial=null, modalidades/portais '{}' (Effecti-only).
--   - frequencia/horario_referencia: placeholders (o agendamento real e
--     governado pelo ciclo global em config_agendamento, sem agendador novo).
--   - recursos: mapa da secao 2.4 -> 'processos' ATIVO com tipos_ativos
--     ['Venda Governamental'], usa_filtro_data_alteracao=false, etapas_terminais=[];
--     demais recursos INATIVOS (futuros visiveis e desligados).
-- ---------------------------------------------------------------------
insert into public.config_ingestao (
  fonte_id, frequencia, horario_referencia, janela_dias, data_inicial, modalidades, portais, recursos
)
select
  f.id,
  'manual',
  null,
  7,
  null,
  '{}'::text[],
  '{}'::text[],
  jsonb_build_object(
    'processos', jsonb_build_object(
      'ativo', true,
      'tipos_ativos', jsonb_build_array('Venda Governamental'),
      'usa_filtro_data_alteracao', false,
      'etapas_terminais', jsonb_build_array()
    ),
    'cobranca',        jsonb_build_object('ativo', false, 'tipos_ativos', jsonb_build_array()),
    'propostas',       jsonb_build_object('ativo', false, 'tipos_ativos', jsonb_build_array()),
    'pedidos',         jsonb_build_object('ativo', false, 'tipos_ativos', jsonb_build_array()),
    'nfes',            jsonb_build_object('ativo', false, 'tipos_ativos', jsonb_build_array()),
    'contas_a_receber', jsonb_build_object('ativo', false, 'tipos_ativos', jsonb_build_array())
  )
from public.fontes f
where f.tipo = 'nomus'
  and not exists (
    select 1 from public.config_ingestao c where c.fonte_id = f.id
  );
