// =====================================================================
// Wrapper fino de API para o dry-run de regra e a guarda de ativacao.
// Caminhos das Edges:
//   /relacionamentos-dry-run       (POST - simula, NAO persiste - F3 read-only)
//   /relacionamentos-ativar        (POST - guarda de ativacao, gate S7)
//
// O dry-run recebe apenas `regra_id` (a Edge carrega a regra ATUAL do
// catalogo, computa o hash dos campos de matching e simula o impacto sem
// escrever). A ativacao (guarda S7) exige o `regra_hash` do dry-run FRESCO
// (E9) + confirmacao DUPLA - o servidor recomputa o hash e rejeita (409)
// se a regra mudou desde o dry-run.
//
// Respostas e payloads permanecem em snake_case (campos do JSON).
// =====================================================================

import { apiFetch } from "@/lib/api/client";
import type {
  AtivarRegraInput,
  AtivarRegraResultado,
  DryRunResponse,
  Regra,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const DRY_RUN_PATH = "relacionamentos-dry-run";
const ATIVAR_PATH = "relacionamentos-ativar";

/** Identificacao minima de uma regra para disparar o dry-run. */
type RegraRef = Pick<Regra, "id"> | { id: string };

// ---------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------

/**
 * Dispara o dry-run de UMA regra do catalogo. Recebe a regra (ou sua
 * referencia com `id`) e um `amostra_max` opcional reservado para evolucao
 * futura do contrato (a borda atual e estrita a `regra_id`, entao so o id e
 * enviado). Devolve a projecao de impacto SEM persistir nada.
 */
export function dryRunRegra(
  regra: RegraRef,
  amostra_max?: number,
): Promise<DryRunResponse> {
  // A Edge e `strict` a `regra_id`: enviar `amostra_max` hoje causaria 400.
  // Mantemos o parametro na assinatura para forward-compat sem transmiti-lo.
  void amostra_max;
  return apiFetch<DryRunResponse>(DRY_RUN_PATH, {
    method: "POST",
    body: JSON.stringify({ regra_id: regra.id }),
  });
}

/**
 * Ativa a regra disparando o backfill via guarda de ativacao (gate S7).
 * Efeito PERMANENTE. Exige o `regra_hash` do dry-run fresco e a confirmacao
 * dupla. Erros esperados: 422 (confirmacao faltando), 409 (regra mudou desde
 * o dry-run OU backfill ja em andamento).
 */
export function ativarRegra(
  input: AtivarRegraInput,
): Promise<AtivarRegraResultado> {
  return apiFetch<AtivarRegraResultado>(ATIVAR_PATH, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
