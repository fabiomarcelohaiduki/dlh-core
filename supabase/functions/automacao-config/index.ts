// =====================================================================
// Edge Function: automacao-config  (cockpit - config singleton da automacao)
//   -> GET / PUT /automacao-config
//
// Le e atualiza o singleton `config_automacao` (carencia, limiares de confianca,
// k few-shot, interruptor de descarte fisico). Fonte unica de verdade da
// classificacao server-side. Leitura NUNCA expoe segredo (a chave de IA segue no
// Vault e nao e usada na triagem V1). Contrato 3.2.6 (RF-22, US-14).
//
//   GET -> { dias_carencia, limiar_inferior, limiar_superior, k_few_shot,
//            descarte_fisico_ligado, modo_execucao_ia, atualizado_em }
//   PUT -> valida zod (dias_carencia 1..365; k_few_shot 0..50; limiares em
//          [0,1]; CHECK limiar_inferior <= limiar_superior -> 400), persiste e
//          retorna o mesmo shape do GET.
//
// RE-DERIVACAO AO SALVAR LIMIARES (E3): como `avisos.triagem_confianca` (crua) e
// persistida e a classificacao e server-side, ao alterar limiar_inferior/superior
// o PUT re-deriva o `triagem_veredito` de TODOS os avisos com confianca
// armazenada, SEM re-chamar o Lion, reusando a classificacao deterministica
// (regras duras E5 + invariante "util tem produto" E12). NAO altera avisos
// `reabilitado = true`. Avisos rebaixados de `lixo` saem da lixeira; avisos que
// passam a `lixo` entram na lixeira soft (na_lixeira_em = now()).
//
// Autorizacao na borda (US-21): requireAuthorizedUser -> 401/403. Escrita
// auditada via logSensitiveAction. Escrita com service_role (tabelas de triagem
// fora das views lia.*, SEC-3).
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  avaliarRegras,
  classificar,
  type LimiaresConfig,
  type RegrasDuras,
} from "../_shared/triagem-ingestao.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "automacao-config";

/** Tamanho do lote de re-derivacao (keyset por id, evita carregar tudo). */
const REDERIVE_BATCH = 500;

// ---------------------------------------------------------------------
// Schema (zod) do PUT. modo_execucao_ia NAO e editavel aqui (reserva futura);
// o GET o retorna como esta no singleton.
// ---------------------------------------------------------------------

const putBodySchema = z
  .object({
    dias_carencia: z
      .number()
      .int("dias_carencia deve ser inteiro")
      .min(1, "dias_carencia minimo 1")
      .max(365, "dias_carencia maximo 365"),
    limiar_inferior: z
      .number()
      .min(0, "limiar_inferior minimo 0")
      .max(1, "limiar_inferior maximo 1"),
    limiar_superior: z
      .number()
      .min(0, "limiar_superior minimo 0")
      .max(1, "limiar_superior maximo 1"),
    k_few_shot: z
      .number()
      .int("k_few_shot deve ser inteiro")
      .min(0, "k_few_shot minimo 0")
      .max(50, "k_few_shot maximo 50"),
    descarte_fisico_ligado: z.boolean(),
    triar_apenas_futuros: z.boolean(),
    triagem_horizonte_dias: z
      .number()
      .int("triagem_horizonte_dias deve ser inteiro")
      .min(0, "triagem_horizonte_dias minimo 0")
      .max(3650, "triagem_horizonte_dias maximo 3650"),
  })
  .superRefine((val, ctx) => {
    if (val.limiar_inferior > val.limiar_superior) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["limiar_inferior"],
        message: "limiar_inferior deve ser menor ou igual a limiar_superior",
      });
    }
  });

type PutBody = z.infer<typeof putBodySchema>;

/** Shape de resposta (GET e PUT). */
interface ConfigResponse {
  dias_carencia: number;
  limiar_inferior: number;
  limiar_superior: number;
  k_few_shot: number;
  descarte_fisico_ligado: boolean;
  triar_apenas_futuros: boolean;
  triagem_horizonte_dias: number;
  modo_execucao_ia: string;
  atualizado_em: string | null;
}

/** Linha do singleton lida do banco (numeric pode chegar como string). */
interface ConfigRow {
  dias_carencia: number | string | null;
  limiar_inferior: number | string | null;
  limiar_superior: number | string | null;
  k_few_shot: number | string | null;
  descarte_fisico_ligado: boolean | null;
  triar_apenas_futuros: boolean | null;
  triagem_horizonte_dias: number | string | null;
  modo_execucao_ia: string | null;
  atualizado_em: string | null;
}

const CONFIG_COLS =
  "dias_carencia, limiar_inferior, limiar_superior, k_few_shot, descarte_fisico_ligado, " +
  "triar_apenas_futuros, triagem_horizonte_dias, modo_execucao_ia, atualizado_em";

/** Mapeia a linha do banco para o shape de resposta (coage numeric -> number). */
function toResponse(row: ConfigRow): ConfigResponse {
  return {
    dias_carencia: Number(row.dias_carencia ?? 30),
    limiar_inferior: Number(row.limiar_inferior ?? 0.35),
    limiar_superior: Number(row.limiar_superior ?? 0.55),
    k_few_shot: Number(row.k_few_shot ?? 8),
    descarte_fisico_ligado: row.descarte_fisico_ligado === true,
    triar_apenas_futuros: row.triar_apenas_futuros === true,
    triagem_horizonte_dias: Number(row.triagem_horizonte_dias ?? 0),
    modo_execucao_ia: row.modo_execucao_ia ?? "lion",
    atualizado_em: row.atualizado_em ?? null,
  };
}

/** Le o singleton (sempre existe via seed). 500 se ausente/erro. */
async function loadConfig(db: ServiceClient): Promise<ConfigRow> {
  const { data, error } = await db
    .from("config_automacao")
    .select(CONFIG_COLS)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler config_automacao: ${error.message}`);
  }
  if (!data) {
    throw new Error("config_automacao ausente (seed nao aplicado)");
  }
  // select por string em variavel quebra a inferencia do PostgREST -> cast.
  return data as unknown as ConfigRow;
}

// ---------------------------------------------------------------------
// GET: retorna a config singleton (sem segredos).
// ---------------------------------------------------------------------

async function handleGet(db: ServiceClient): Promise<Response> {
  const row = await loadConfig(db);
  return jsonResponse(toResponse(row), 200);
}

// ---------------------------------------------------------------------
// Re-derivacao em massa (E3) ao alterar limiares.
// ---------------------------------------------------------------------

/** Le as regras duras ativas agrupadas por tipo (mesma fonte da triagem). */
async function loadRegrasDuras(db: ServiceClient): Promise<RegrasDuras> {
  const { data, error } = await db
    .from("triagem_regras")
    .select("tipo, termo")
    .eq("ativo", true);
  if (error) {
    throw new Error(`falha ao ler triagem_regras: ${error.message}`);
  }
  const foraDeRamo: string[] = [];
  const termoProduto: string[] = [];
  for (const row of (data ?? []) as { tipo: string; termo: string }[]) {
    if (row.tipo === "fora_de_ramo") foraDeRamo.push(row.termo);
    else if (row.tipo === "termo_produto") termoProduto.push(row.termo);
  }
  return { fora_de_ramo: foraDeRamo, termo_produto: termoProduto };
}

interface AvisoRederiveRow {
  id: string;
  objeto: string | null;
  conteudo_verbatim: string | null;
  triagem_confianca: number | string | null;
  triagem_veredito: string | null;
  na_lixeira: boolean | null;
  na_lixeira_em: string | null;
}

/** Produto candidato (id + nome) da decisao vigente por aviso (E12). */
async function loadProdutoCandidatos(
  db: ServiceClient,
  avisoIds: string[],
): Promise<Map<string, { produto_id: string | null; nome: string | null }>> {
  const map = new Map<string, { produto_id: string | null; nome: string | null }>();
  if (avisoIds.length === 0) return map;

  const { data, error } = await db
    .from("triagem_decisoes")
    .select("aviso_id, produto_candidato_id, produto_candidato_nome, decidido_em")
    .in("aviso_id", avisoIds)
    .order("decidido_em", { ascending: false });
  if (error) {
    throw new Error(`falha ao ler triagem_decisoes: ${error.message}`);
  }
  for (
    const row of (data ?? []) as {
      aviso_id: string;
      produto_candidato_id: string | null;
      produto_candidato_nome: string | null;
    }[]
  ) {
    // Primeira ocorrencia por aviso = decisao vigente (ordenado desc).
    if (!map.has(row.aviso_id)) {
      map.set(row.aviso_id, {
        produto_id: row.produto_candidato_id ?? null,
        nome: row.produto_candidato_nome ?? null,
      });
    }
  }
  return map;
}

/**
 * Re-deriva o `triagem_veredito` de todos os avisos com confianca armazenada,
 * reusando a classificacao server-side (E5 + E12). Processa em lotes (keyset por
 * id) e so escreve nos avisos cujo veredito ou estado de lixeira mudou. NUNCA
 * altera avisos `reabilitado = true`. Retorna a quantidade de avisos alterados.
 */
async function rederivarVereditos(
  db: ServiceClient,
  limiares: LimiaresConfig,
): Promise<number> {
  const regras = await loadRegrasDuras(db);
  const agora = new Date().toISOString();
  let alterados = 0;
  let cursorId: string | null = null;

  for (;;) {
    let query = db
      .from("avisos")
      .select(
        "id, objeto, conteudo_verbatim, triagem_confianca, triagem_veredito, " +
          "na_lixeira, na_lixeira_em",
      )
      .not("triagem_confianca", "is", null)
      .eq("reabilitado", false)
      .order("id", { ascending: true })
      .limit(REDERIVE_BATCH);
    if (cursorId) {
      query = query.gt("id", cursorId);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`falha ao ler avisos para re-derivacao: ${error.message}`);
    }
    const avisos = (data ?? []) as unknown as AvisoRederiveRow[];
    if (avisos.length === 0) break;

    const produtos = await loadProdutoCandidatos(db, avisos.map((a) => a.id));

    for (const aviso of avisos) {
      const confianca = Number(aviso.triagem_confianca);
      if (!Number.isFinite(confianca)) continue;

      const texto = `${aviso.objeto ?? ""}\n${aviso.conteudo_verbatim ?? ""}`;
      const regrasCasadas = avaliarRegras(texto, regras);
      const produto = produtos.get(aviso.id) ?? null;
      const classificacao = classificar(confianca, produto, regrasCasadas, limiares);

      const vereditoNovo = classificacao.veredito;
      const estavaNaLixeira = aviso.na_lixeira === true;
      const deveLixeira = vereditoNovo === "lixo";

      // Sem mudanca de veredito nem de estado de lixeira: nao escreve.
      const vereditoMudou = vereditoNovo !== aviso.triagem_veredito;
      const lixeiraMudou = deveLixeira !== estavaNaLixeira;
      if (!vereditoMudou && !lixeiraMudou) continue;

      const patch: Record<string, unknown> = {
        triagem_veredito: vereditoNovo,
        triagem_em: agora,
      };
      if (deveLixeira && !estavaNaLixeira) {
        // Passou a lixo: entra na lixeira soft.
        patch.na_lixeira = true;
        patch.na_lixeira_em = agora;
      } else if (!deveLixeira && estavaNaLixeira) {
        // Rebaixado de lixo: sai da lixeira.
        patch.na_lixeira = false;
        patch.na_lixeira_em = null;
      }

      const { error: upErr } = await db
        .from("avisos")
        .update(patch)
        .eq("id", aviso.id)
        .eq("reabilitado", false);
      if (upErr) {
        throw new Error(`falha ao re-derivar veredito do aviso ${aviso.id}: ${upErr.message}`);
      }
      alterados++;
    }

    if (avisos.length < REDERIVE_BATCH) break;
    cursorId = avisos[avisos.length - 1].id;
  }

  return alterados;
}

// ---------------------------------------------------------------------
// PUT: persiste a config; re-deriva quando limiares mudam.
// ---------------------------------------------------------------------

async function handlePut(req: Request, db: ServiceClient, usuario: string): Promise<Response> {
  const body: PutBody = await parseJsonBody(req, putBodySchema);

  const atual = await loadConfig(db);
  const limiaresMudaram = Number(atual.limiar_inferior ?? 0.35) !== body.limiar_inferior ||
    Number(atual.limiar_superior ?? 0.55) !== body.limiar_superior;

  // Persiste o singleton (trigger atualiza atualizado_em). modo_execucao_ia
  // permanece inalterado (nao editavel por este contrato).
  const { data: updatedRaw, error: upErr } = await db
    .from("config_automacao")
    .update({
      dias_carencia: body.dias_carencia,
      limiar_inferior: body.limiar_inferior,
      limiar_superior: body.limiar_superior,
      k_few_shot: body.k_few_shot,
      descarte_fisico_ligado: body.descarte_fisico_ligado,
      triar_apenas_futuros: body.triar_apenas_futuros,
      triagem_horizonte_dias: body.triagem_horizonte_dias,
      atualizado_por: usuario,
    })
    .eq("singleton", true)
    .select(CONFIG_COLS)
    .maybeSingle();
  if (upErr) {
    throw new Error(`falha ao atualizar config_automacao: ${upErr.message}`);
  }
  if (!updatedRaw) {
    throw new Error("config_automacao ausente (seed nao aplicado)");
  }
  const updated = updatedRaw as unknown as ConfigRow;

  // Re-derivacao em massa (E3): so quando os limiares de fato mudaram.
  let rederivados = 0;
  if (limiaresMudaram) {
    rederivados = await rederivarVereditos(db, {
      limiar_inferior: body.limiar_inferior,
      limiar_superior: body.limiar_superior,
    });
  }

  await logSensitiveAction({
    tabela: "config_automacao",
    acao: "config_atualizar",
    usuario,
    dadosAnteriores: {
      dias_carencia: Number(atual.dias_carencia ?? 30),
      limiar_inferior: Number(atual.limiar_inferior ?? 0.35),
      limiar_superior: Number(atual.limiar_superior ?? 0.55),
      k_few_shot: Number(atual.k_few_shot ?? 8),
      descarte_fisico_ligado: atual.descarte_fisico_ligado === true,
      triar_apenas_futuros: atual.triar_apenas_futuros === true,
      triagem_horizonte_dias: Number(atual.triagem_horizonte_dias ?? 0),
    },
    dadosNovos: {
      dias_carencia: body.dias_carencia,
      limiar_inferior: body.limiar_inferior,
      limiar_superior: body.limiar_superior,
      k_few_shot: body.k_few_shot,
      descarte_fisico_ligado: body.descarte_fisico_ligado,
      triar_apenas_futuros: body.triar_apenas_futuros,
      triagem_horizonte_dias: body.triagem_horizonte_dias,
      limiares_mudaram: limiaresMudaram,
      avisos_rederivados: rederivados,
    },
  });

  return jsonResponse(toResponse(updated), 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "PUT"]);

    // Autorizacao na borda: 401 sem sessao, 403 fora da allowlist.
    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();

    switch (req.method) {
      case "GET":
        return await handleGet(db);
      case "PUT":
        return await handlePut(req, db, ctx.email);
      default:
        return await handleGet(db);
    }
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
