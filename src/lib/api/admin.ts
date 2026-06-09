import { apiFetch } from "@/lib/api/client";
import type {
  BuscaSemanticaResponse,
  DispararGmailResponse,
  DispararNomusResponse,
  FonteTipo,
  Frequencia,
  NomusModo,
  SalvarAgendamentoResponse,
  SalvarConfigResponse,
  SalvarCredencialResponse,
  TestarConexaoResponse,
} from "@/lib/api/types";

/** Payload validado (cliente) do PUT /agendamento-fonte-config (por fonte). */
export interface SalvarAgendamentoFonteInput {
  fonte: FonteTipo;
  /** Recurso/modulo quando o agendamento e por modulo (ex.: Nomus/processos). */
  recurso?: string | null;
  ativo: boolean;
  frequencia: Frequencia;
  horarioReferencia: string | null;
  diaSemana: number | null;
  diaMes: number | null;
}

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
 * Payload validado (cliente) do PUT /ingestao/config. A config por-fonte aqui
 * cobre apenas janela + filtros; a frequencia/horario da coleta moram no
 * agendamento por fonte (ver salvarAgendamentoFonte). `frequencia` e OPCIONAL
 * no schema backend e e OWNED pelo agendamento-fonte-config; por isso esta
 * chamada NAO a envia (enviar 'manual' sobrescrevia a coluna e dessincronizava
 * o card de Agendamento do pg_cron real).
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
 * [1, 365] e portais vazio. Nao toca em frequencia/agendamento.
 */
export function salvarConfig(input: SalvarConfigInput): Promise<SalvarConfigResponse> {
  return apiFetch<SalvarConfigResponse>("ingestao-config", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/**
 * PUT /agendamento-fonte-config — persiste o agendamento DESTA fonte na sua
 * config_ingestao e reescreve o pg_cron coleta-<tipo> via
 * aplicar_agendamento_fonte(). Vale so para a fonte indicada (relogio proprio);
 * a resposta traz o texto do agendamento aplicado.
 */
export function salvarAgendamentoFonte(
  input: SalvarAgendamentoFonteInput,
): Promise<SalvarAgendamentoResponse> {
  return apiFetch<SalvarAgendamentoResponse>("agendamento-fonte-config", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/**
 * POST /nomus-disparar — aciona MANUALMENTE a coleta do Nomus pelo card da
 * fonte. O Nomus coleta no runner do GitHub Actions (TLS legado); este disparo
 * roda o workflow_dispatch no modo escolhido (incremental|full). Responde 202
 * (aceito); a coleta progride assincrona (acompanhar pelo painel).
 */
export function dispararNomus(
  modo: NomusModo,
  recurso?: string,
): Promise<DispararNomusResponse> {
  return apiFetch<DispararNomusResponse>("nomus-disparar", {
    method: "POST",
    body: JSON.stringify(recurso ? { modo, recurso } : { modo }),
  });
}

/**
 * POST /gmail-disparar — aciona MANUALMENTE a coleta do Gmail pelo card da
 * fonte. O Gmail coleta no runner do GitHub Actions (coletar-gmail.yml); a
 * janela vem do gmail-config (data inicial + labels), por isso
 * a chamada nao leva corpo. Responde 202 (aceito); a coleta progride assincrona
 * (acompanhar pelo painel de Execucoes).
 */
export function dispararGmail(): Promise<DispararGmailResponse> {
  return apiFetch<DispararGmailResponse>("gmail-disparar", {
    method: "POST",
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
