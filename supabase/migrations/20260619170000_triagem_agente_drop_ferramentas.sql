-- =====================================================================
-- triagem_agente_config: DROP da coluna vestigial `ferramentas`.
--
-- A coluna nasceu de um enum fechado de tools LOCAIS imaginadas (busca_produtos
-- / recuperar_trechos / aplicar_regras_duras) que NUNCA casou com as tools reais
-- do subagente (MCP acervo-*). Nada le esse campo no fluxo: a fila entrega
-- persona_prompt + instrucoes_operacionais (metodo) e o subagente carrega as
-- tools deferidas via ToolSearch. O enum so servia para disparar 400 espurio no
-- PUT da persona. Removida do schema, da Edge automacao-agente-config, da fila
-- (_shared/triagem-fila.ts) e do cockpit.
--
-- Idempotente (drop column if exists). NAO mexe em dados: a coluna nao alimenta
-- nenhuma logica deterministica nem o veredito.
-- =====================================================================

alter table public.triagem_agente_config
  drop column if exists ferramentas;

comment on table public.triagem_agente_config is
  'Singleton: configuracao do agente de triagem (persona_prompt, instrucoes_operacionais = metodo do modo, versao auto-incrementada a cada update).';
