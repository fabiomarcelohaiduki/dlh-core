// =====================================================================
// Edge Function: relacionamentos-ativar  ->  POST /relacionamentos-ativar
//
// GUARDA DE ATIVACAO (gate S7). Ativa uma regra do catalogo com EFEITO
// PERMANENTE, disparando o backfill real (helper compartilhado
// `_shared/relacionamentos-backfill.ts`) apenas apos passar por DOIS gates:
//
//   1) Confirmacao DUPLA no corpo: `confirmar` E `confirmar_efeito_permanente`
//      ambos true. Faltando qualquer um -> 422 (efeito permanente exige
//      consentimento explicito).
//
//   2) Gate de FRESCOR STATELESS (E9): o servidor RECOMPUTA o hash de
//      conteudo dos campos de matching da regra ATUAL (mesma funcao
//      `hashRegraMatching` usada por relacionamentos-dry-run) e compara com o
//      `regra_hash` enviado pela UI (obtido do dry-run). Se divergir -> 409
//      'regra mudou desde o dry-run, refaca'. NAO consulta nenhum storage de
//      "ultimo dry-run" - nada foi persistido pelo dry-run (preserva o
//      invariante read-only de feat-017).
//
// Caminho EXCLUSIVAMENTE humano - NAO aceita X-Cron-Secret. Sessao validada
// via `requireAuthorizedUser` (Bearer + allowlist `contas_autorizadas`).
// Single-flight identico ao `relacionamentos-backfill`: 409
// `execucao_em_andamento` quando ja ha run ativo.
//
// Em sucesso: { regra_id, executado, arestas_afetadas, gate: 'S7' } e
// auditoria via logSensitiveAction (acao='relacionamento_ativar').
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";
import { hashRegraMatching } from "../_shared/relacionamentos-regra-hash.ts";
import { parseJsonBody, relacionamentosAtivarGuardSchema } from "../_shared/validation.ts";
import {
  execucaoBackfillAtiva,
  runRelacionamentosBackfill,
} from "../_shared/relacionamentos-backfill.ts";

const FUNCTION_SEGMENT = "relacionamentos-ativar";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Campos de matching da regra atual (fonte do hash de frescor). */
interface RegraMatchingRow {
  id: string;
  origem_tipo: string;
  campo_origem: string;
  destino_tipo: string;
  campo_destino: string;
  combinacao: "simples" | "composta";
  sequencia: string[] | null;
}

/** Carrega a regra do catalogo escopada por org. 404 se inexistente. */
async function carregarRegra(
  db: ServiceClient,
  regraId: string,
  orgId: string,
): Promise<RegraMatchingRow> {
  const { data, error } = await db
    .from("catalogo_regras_vinculo")
    .select(
      "id, origem_tipo, campo_origem, destino_tipo, campo_destino, combinacao, sequencia",
    )
    .eq("id", regraId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "catalogo_regras_query_failed", "falha ao consultar a regra");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "regra nao encontrada");
  }
  return data as RegraMatchingRow;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    // Borda: metodo antes da autenticacao; autenticacao antes do corpo.
    assertMethod(req, "POST");
    // Caminho EXCLUSIVAMENTE humano - NAO aceita X-Cron-Secret.
    const { email, user } = await requireAuthorizedUser(req);

    const db = createServiceClient();
    const orgId = await resolverOrgIdUsuario(db, user.id);

    // Validacao de schema (400). Campos obrigatorios: regra_id, regra_hash,
    // confirmar, confirmar_efeito_permanente.
    const input = await parseJsonBody(req, relacionamentosAtivarGuardSchema);

    // Gate 1: confirmacao DUPLA. Faltando qualquer confirmacao -> 422.
    if (input.confirmar !== true || input.confirmar_efeito_permanente !== true) {
      throw new HttpError(
        422,
        "confirmacao_dupla_requerida",
        "ativacao com efeito permanente exige confirmar=true e confirmar_efeito_permanente=true",
      );
    }

    // Gate 2 (E9): frescor STATELESS. Recomputa o hash da regra ATUAL com a
    // MESMA funcao do dry-run e compara com o enviado pela UI. Divergiu =>
    // 409 (a regra mudou desde o dry-run).
    const regra = await carregarRegra(db, input.regra_id, orgId);
    const hashAtual = hashRegraMatching(regra);
    if (hashAtual !== input.regra_hash) {
      throw new HttpError(
        409,
        "regra_mudou",
        "regra mudou desde o dry-run, refaca",
        { regra_hash_atual: hashAtual, regra_hash_enviado: input.regra_hash },
      );
    }

    // Single-flight identico ao `relacionamentos-backfill`.
    const ativa = await execucaoBackfillAtiva(db);
    if (ativa) {
      throw new HttpError(
        409,
        "execucao_em_andamento",
        "ja existe um backfill de relacionamentos em andamento",
        { execucao_id: ativa },
      );
    }

    // Auditoria do disparo humano (best-effort). Ocorre ANTES do run para
    // registrar a intencao mesmo em caso de erro subsequente.
    await logSensitiveAction({
      tabela: "catalogo_regras_vinculo",
      acao: "relacionamento_ativar",
      registroId: regra.id,
      usuario: email,
      dadosNovos: {
        gate: "S7",
        regra_hash: hashAtual,
        motivo: input.motivo ?? null,
        origem: "botao_ativar_cockpit",
      },
    });

    // Backfill restrito a ESTA regra (esboco §4.5): pula as Fases 1 e 3 e
    // roda so a Fase 2 da regra ativada, ignorando modo_disparo.
    const resultado = await runRelacionamentosBackfill({
      db,
      etapa: FUNCTION_SEGMENT,
      gatilho: "manual",
      orgId,
      regraId: regra.id,
    });

    return jsonResponse(
      {
        regra_id: regra.id,
        executado: true,
        arestas_afetadas: resultado.arestas_criadas,
        arestas_removidas: resultado.arestas_removidas,
        gate: "S7",
      },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
