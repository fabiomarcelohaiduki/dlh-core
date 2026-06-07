-- =====================================================================
-- Sprint: Substrato de dados (secao 2.4 da SPEC)
-- Migration 08/08: Seed inicial (onboarding)
--   - 1 fonte Effecti (estado 'nao_configurada', token_cifrado null)
--   - 1 config_ingestao default vinculada a Effecti
--   - >= 1 conta autorizada (dominio confiavel, ativo = true)
-- SEM seed de avisos/execucoes/erros: os estados empty sao reais no primeiro
-- acesso e orquestram o onboarding.
-- Inserts idempotentes (re-aplicacao da migration nao duplica registros).
-- =====================================================================

-- ---------------------------------------------------------------------
-- fontes: 1 registro semente da fonte Effecti (US-07, US-00).
-- Ajustar endpoint_base para a URL oficial da API Effecti em producao.
-- ---------------------------------------------------------------------
insert into public.fontes (nome, tipo, endpoint_base, estado_conexao, token_cifrado)
select 'Effecti', 'effecti', 'https://api.effecti.com.br', 'nao_configurada', null
where not exists (
  select 1 from public.fontes where tipo = 'effecti'
);

-- ---------------------------------------------------------------------
-- config_ingestao: default vinculada a Effecti (US-03, US-20).
-- frequencia = placeholder; janela_dias = 15; modalidades/portais vazios.
-- ---------------------------------------------------------------------
insert into public.config_ingestao (fonte_id, frequencia, horario_referencia, janela_dias, modalidades, portais)
select f.id, 'manual', null, 15, '{}'::text[], '{}'::text[]
from public.fontes f
where f.tipo = 'effecti'
  and not exists (
    select 1 from public.config_ingestao c where c.fonte_id = f.id
  );

-- ---------------------------------------------------------------------
-- contas_autorizadas: dominio confiavel do nucleo DLH para o primeiro
-- acesso (US-21, RF-38). SUBSTITUIR 'dlh.com.br' pelo dominio real
-- (env AUTHORIZED_EMAIL_DOMAIN). valor e UNIQUE => on conflict do nothing.
-- ---------------------------------------------------------------------
insert into public.contas_autorizadas (tipo, valor, ativo)
values ('dominio', 'dlh.com.br', true)
on conflict (valor) do nothing;
