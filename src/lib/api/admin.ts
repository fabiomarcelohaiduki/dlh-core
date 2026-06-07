import { apiFetch } from "@/lib/api/client";
import type {
  BuscaSemanticaResponse,
  FonteTipo,
  Frequencia,
  SalvarAgendamentoResponse,
  SalvarConfigResponse,
  SalvarCredencialResponse,
  TestarConexaoResponse,
} from "@/lib/api/types";

/**
 * PUT /fontes-credencial — grava a chave de integracao da fonte no Vault
 * (US-07/US-03). Parametrizado por fonte (effecti|nomus, default effecti). O
 * segredo so trafega na ida (request); a resposta nunca devolve o token
 * (RNF-02). token vazio e bloqueado por zod no cliente e no servidor.
 */
export function salvarCredencial(
  token: string,
  fonte: FonteTipo = "effecti",
): Promise<SalvarCredencialResponse> {
  return apiFetch<SalvarCredencialResponse>("fontes-credencial", {
    method: "PUT",
    body: JSON.stringify({ fonte, token }),
  });
}

/**
 * POST /fontes-testar — testa a conexao usando a credencial do Vault.
 * Parametrizado por fonte (effecti|nomus, default effecti). Independente do
 * salvar: pode falhar (estadoConexao='erro' + causa) mesmo apos um salvar
 * bem-sucedido. credencial ausente -> 200 estadoConexao='nao_configurada'.
 */
export function testarConexao(fonte: FonteTipo = "effecti"): Promise<TestarConexaoResponse> {
  return apiFetch<TestarConexaoResponse>("fontes-testar", {
    method: "POST",
    body: JSON.stringify({ fonte }),
  });
}

/**
 * Payload validado (cliente) do PUT /ingestao/config. Por-fonte ficou apenas
 * com janela + filtros; a frequencia/horario do ciclo viraram GLOBAIS (ver
 * salvarAgendamento). O schema backend ainda exige `frequencia`, por isso
 * salvarConfig injeta 'manual' (coluna config_ingestao.frequencia inerte:
 * nada le essa coluna para agendar; o cron global comanda a coleta).
 */
export interface SalvarConfigInput {
  janelaDias: number;
  modalidades: string[];
  portais: string[];
}

/**
 * PUT /ingestao/config — persiste janela/modalidades/portais da fonte.
 * As alteracoes valem na PROXIMA execucao (sem redeploy); nao afetam a
 * coleta em andamento. zod cliente + servidor rejeitam janela fora de
 * [1, 365] e portais vazio.
 */
export function salvarConfig(input: SalvarConfigInput): Promise<SalvarConfigResponse> {
  return apiFetch<SalvarConfigResponse>("ingestao-config", {
    method: "PUT",
    body: JSON.stringify({ frequencia: "manual" satisfies Frequencia, ...input }),
  });
}

/** Payload validado (cliente) do PUT /agendamento/config (ciclo global). */
export interface SalvarAgendamentoInput {
  ativo: boolean;
  frequencia: Frequencia;
  horarioReferencia: string | null;
  diaSemana: number | null;
  diaMes: number | null;
}

/**
 * PUT /agendamento/config — persiste o agendamento GLOBAL do ciclo (singleton)
 * e reescreve o pg_cron via aplicar_agendamento(). Vale para TODAS as fontes
 * (orquestrador sequencial); a resposta traz o texto do agendamento aplicado.
 */
export function salvarAgendamento(
  input: SalvarAgendamentoInput,
): Promise<SalvarAgendamentoResponse> {
  return apiFetch<SalvarAgendamentoResponse>("agendamento-config", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** Payload da busca semantica (topK ja normalizado/limitado no cliente). */
export interface BuscaSemanticaInput {
  query: string;
  topK: number;
}

/**
 * POST /v1/substrato/busca-semantica — playground humano de validacao.
 * Usa a sessao do cockpit (Bearer da sessao Supabase); NUNCA expoe a API
 * key de servico da Lia. query vazia e rejeitada antes do disparo.
 */
export function buscaSemantica(
  input: BuscaSemanticaInput,
): Promise<BuscaSemanticaResponse> {
  return apiFetch<BuscaSemanticaResponse>("v1-substrato-busca-semantica", {
    method: "POST",
    body: JSON.stringify({ query: input.query, topK: input.topK }),
  });
}
