// =====================================================================
// Edge Function: v1-politica-participacao  (consulta de DECISAO deterministica)
//   -> POST /v1-politica-participacao
//
// Apos a refatoracao de RECALL POR ITEM, o servidor NAO carimba mais a politica
// de participacao na fila (nao ha mais cruzamento servidor x catalogo). A Lia
// identifica os produtos a partir dos itens do edital (acervo_search) e CONSULTA
// aqui a politica de cada um. A politica e DECISAO DETERMINISTICA (vem do banco,
// nunca da IA) — SOM: a IA identifica o produto (probabilistico), a regra de
// participar/nao-participar e do banco.
//
// Precedencia de resolucao: SKU > PRODUTO > LINHA. A Lia envia o produto_id
// (e opcionalmente o sku_id) de cada alvo; o servidor resolve a linha do produto
// e aplica a precedencia. Retorna a politica resolvida + o nivel onde casou, ou
// null quando nao ha politica cadastrada em nenhum nivel.
//
// Autorizacao na borda (SEC-1): authenticateV1 com read-only:busca-semantica
// (mesma chave read-only da Lia que usa a fila). Sem credencial -> 401; escopo
// errado / sessao humana -> 403. Leitura roda com service_role.
//
// Codigos: 200 ok; 400 body invalido (zod); 401 sem credencial; 403 escopo.
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, LIA_SERVICE_SCOPE } from "../_shared/service-auth.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { createServiceClient } from "../_shared/supabase.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "v1-politica-participacao";

// Defesa em profundidade: cap de alvos por chamada (a Lia consulta os produtos
// que identificou num edital; editais grandes raramente passam de algumas dezenas).
const MAX_ALVOS = 200;

// ---------------------------------------------------------------------
// Validacao do corpo (zod). Body invalido -> 400 (parseJsonBody).
// ---------------------------------------------------------------------

const alvoSchema = z.object({
  produto_id: z.string().uuid("produto_id deve ser um uuid valido"),
  // Opcional: quando a Lia chega ao SKU especifico, a precedencia usa sku > produto.
  sku_id: z.string().uuid("sku_id deve ser um uuid valido").nullish(),
});

const bodySchema = z.object({
  alvos: z.array(alvoSchema).min(1, "informe ao menos 1 alvo").max(MAX_ALVOS),
});

type PoliticaBody = z.infer<typeof bodySchema>;

// Politica resolvida (espelha o carimbo que a fila antes entregava).
interface PoliticaResolvida {
  participa: "sim" | "nao" | "condicional";
  /** Nivel onde a politica casou (precedencia sku > produto > linha). */
  nivel: "sku" | "produto" | "linha";
  condicao: string | null;
  diretriz_texto: string | null;
  preferencia: string | null;
}

interface AlvoResolvido {
  produto_id: string;
  sku_id: string | null;
  linha_id: string | null;
  nome: string | null;
  /**
   * O produto_id existe na tabela produtos? Distingue "produto inexistente"
   * (encontrado=false, a Lia errou o id) de "produto sem politica cadastrada"
   * (encontrado=true, politica=null). Sem isso ambos vinham como null+null.
   */
  encontrado: boolean;
  politica: PoliticaResolvida | null;
}

interface PoliticaRow {
  nivel: "sku" | "produto" | "linha";
  escopo_id: string;
  participa: "sim" | "nao" | "condicional";
  condicao: string | null;
  diretriz_texto: string | null;
  preferencia: string | null;
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao na borda: recurso de servico READ-ONLY (mesma chave da fila).
    await authenticateV1(req, { requiredScope: LIA_SERVICE_SCOPE });

    const body: PoliticaBody = await parseJsonBody(req, bodySchema);
    const db: ServiceClient = createServiceClient();

    const produtoIds = [...new Set(body.alvos.map((a) => a.produto_id))];

    // 1) Linha + nome de cada produto (resolve o nivel LINHA da precedencia).
    const { data: produtos, error: prodErr } = await db
      .from("produtos")
      .select("id, nome, linha_id")
      .in("id", produtoIds);
    if (prodErr) {
      throw new Error(`falha ao ler produtos: ${prodErr.message}`);
    }
    const produtoMeta = new Map<string, { nome: string | null; linha_id: string | null }>();
    for (const p of (produtos ?? []) as { id: string; nome: string | null; linha_id: string | null }[]) {
      produtoMeta.set(p.id, { nome: p.nome ?? null, linha_id: p.linha_id ?? null });
    }

    // 2) Mapa de politicas (tabela pequena: leitura unica, sem filtro).
    const politicaMap = await loadPoliticaMap(db);

    // 3) Resolve cada alvo por precedencia SKU > PRODUTO > LINHA.
    const resolvidos: AlvoResolvido[] = body.alvos.map((alvo) => {
      const meta = produtoMeta.get(alvo.produto_id);
      const linhaId = meta?.linha_id ?? null;
      const politica = (alvo.sku_id ? politicaMap.get(`sku:${alvo.sku_id}`) : undefined) ??
        politicaMap.get(`produto:${alvo.produto_id}`) ??
        (linhaId ? politicaMap.get(`linha:${linhaId}`) : undefined) ??
        null;
      return {
        produto_id: alvo.produto_id,
        sku_id: alvo.sku_id ?? null,
        linha_id: linhaId,
        nome: meta?.nome ?? null,
        encontrado: meta !== undefined,
        politica,
      };
    });

    return jsonResponse({ alvos: resolvidos }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

/** Carrega politica_participacao -> Map por `${nivel}:${escopo_id}`. */
async function loadPoliticaMap(
  db: ServiceClient,
): Promise<Map<string, PoliticaResolvida>> {
  const map = new Map<string, PoliticaResolvida>();
  const { data, error } = await db
    .from("politica_participacao")
    .select("nivel, escopo_id, participa, condicao, diretriz_texto, preferencia");
  if (error) {
    throw new Error(`falha ao ler politica_participacao: ${error.message}`);
  }
  for (const r of (data ?? []) as PoliticaRow[]) {
    // Uma politica por escopo; duplicata -> a primeira prevalece.
    const key = `${r.nivel}:${r.escopo_id}`;
    if (map.has(key)) continue;
    map.set(key, {
      participa: r.participa,
      nivel: r.nivel,
      condicao: r.condicao ?? null,
      diretriz_texto: r.diretriz_texto ?? null,
      preferencia: r.preferencia ?? null,
    });
  }
  return map;
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
