// =====================================================================
// Edge Function: v1-selecionar-sku  (Dominio F - Consumo pela Lia /v1)
//   -> POST /v1-selecionar-sku
//
// Seleciona DETERMINISTICAMENTE o SKU a cotar dentro de um produto ja
// identificado pelo match semantico. Divisao de trabalho (principio SOM):
//   - LLM (subagente): acha o PRODUTO e extrai os sinais do item do edital
//     (cor, medidas, grau de qualidade).
//   - Servidor (esta Edge): escolhe o SKU EXATO. Regra critica fora da IA.
//
// Algoritmo (atributos estruturados em produto_skus, nada de embedding):
//   1. Candidatos = SKUs ativos do produto_id.
//   2. Cor: se exigida e o SKU tem atributos.Cor, mantem so a cor que casa.
//   3. Qualidade (escada comercial<plus<especial<super): alvo = grau_exigido
//      ?? comercial; mantem esse grau; se nao existir, sobe pro proximo
//      disponivel. Produto sem escada (Qualidade null) ignora o filtro.
//   4. Dimensao (rotacao-livre, modo do edital):
//      - modo "minimo" (default = "minimas"/"no minimo"/sem margem): FECHA
//        pelo tamanho. Valido = area do SKU >= area pedida E nenhum lado cai
//        mais de 10% abaixo do pedido. Quando a grade trava um lado (ex: a
//        qualidade ESP limita o comprimento), o "fechar a area" joga a
//        diferenca pro outro lado sozinho. Escolha = MENOR area que fecha.
//      - modo "aprox" (edital diz "aproximadamente"/"~"/"cerca de"): pode
//        descer ao primeiro tamanho menor. Escolha = MAIOR SKU que nao
//        ultrapassa o pedido em nenhum lado; se nao houver menor, cai no minimo.
//   5. Sem candidato em algum filtro -> sku_id null + motivo (cor|grau|dimensao).
//
// Autenticacao /v1 (RNF-01/02): authenticateV1 (Bearer lia_sk_ do Vault OU
// sessao do cockpit). Sem credencial -> 401; sessao fora da allowlist -> 403.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, principalLabel, type V1Principal } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { isUuid } from "../_shared/rest.ts";

const FUNCTION_SEGMENT = "v1-selecionar-sku";
const ESCOPO = "selecionar-sku";

// Escada de qualidade (menor = mais barato). NULL = produto sem escada.
const ORDEM_GRAU: Record<string, number> = { comercial: 1, plus: 2, especial: 3, super: 4 };

// Piso por lado no modo minimo: nenhum lado pode cair mais que 10% abaixo do
// pedido (guard "nao mude muito" quando a area fecha pelo outro lado).
const PISO_LADO = 0.9;

interface SkuRow {
  id: string;
  codigo_sku: string;
  dimensoes: Record<string, unknown> | null;
  atributos: Record<string, unknown> | null;
}

interface Entrada {
  produto_id: string;
  cor_exigida: string | null;
  larg_mm: number | null;
  comp_mm: number | null;
  grau_exigido: string | null;
  modo: "minimo" | "aprox";
}

interface DimCand {
  s: SkuRow;
  sMax: number;
  sMin: number;
  area: number;
}

/** Normaliza para comparacao tolerante a acento/caixa. */
function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Par ordenado (maior, menor) de um retangulo, ou null se nao tiver as 2 medidas. */
function parOrdenado(larg: number | null, comp: number | null): [number, number] | null {
  if (larg == null || comp == null) return null;
  return larg >= comp ? [larg, comp] : [comp, larg];
}

/** Area do SKU para desempate (menor = mais barato). Infinity se sem medida. */
function areaSku(dim: Record<string, unknown> | null): number {
  const l = asNumber(dim?.["largura_mm"]);
  const c = asNumber(dim?.["comprimento_mm"]);
  if (l == null || c == null) return Number.POSITIVE_INFINITY;
  return l * c;
}

function parseEntrada(body: unknown): Entrada {
  if (typeof body !== "object" || body === null) {
    throw new HttpError(400, "validation_error", "corpo JSON obrigatorio");
  }
  const b = body as Record<string, unknown>;
  const produto_id = b["produto_id"];
  if (typeof produto_id !== "string" || !isUuid(produto_id)) {
    throw new HttpError(400, "validation_error", "produto_id invalido (UUID esperado)");
  }
  const optStr = (v: unknown, campo: string): string | null => {
    if (v == null) return null;
    if (typeof v !== "string") throw new HttpError(400, "validation_error", `${campo} deve ser string`);
    const t = v.trim();
    return t === "" ? null : t;
  };
  const optNum = (v: unknown, campo: string): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      throw new HttpError(400, "validation_error", `${campo} deve ser numero positivo (mm)`);
    }
    return n;
  };
  const grau = optStr(b["grau_exigido"], "grau_exigido");
  if (grau != null && !(norm(grau) in ORDEM_GRAU)) {
    throw new HttpError(400, "validation_error", "grau_exigido deve ser comercial|plus|especial|super");
  }
  const modoRaw = optStr(b["modo"], "modo");
  const modo = modoRaw ? norm(modoRaw) : "minimo";
  if (modo !== "minimo" && modo !== "aprox") {
    throw new HttpError(400, "validation_error", "modo deve ser minimo|aprox");
  }
  return {
    produto_id,
    cor_exigida: optStr(b["cor_exigida"], "cor_exigida"),
    larg_mm: optNum(b["larg_mm"], "larg_mm"),
    comp_mm: optNum(b["comp_mm"], "comp_mm"),
    grau_exigido: grau ? norm(grau) : null,
    modo,
  };
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    const principal = await authenticateV1(req);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new HttpError(400, "validation_error", "corpo JSON invalido");
    }
    const entrada = parseEntrada(raw);

    const db = createServiceClient();
    const { data, error } = await db
      .from("produto_skus")
      .select("id, codigo_sku, dimensoes, atributos")
      .eq("produto_id", entrada.produto_id)
      .eq("ativo", true);
    if (error) {
      throw new HttpError(500, "sku_query_failed", "falha ao consultar os SKUs do produto");
    }
    const candidatos = (data as SkuRow[] | null) ?? [];

    // Resposta padrao de nao-atendimento.
    const semSku = (motivo: string, detalhe: string) =>
      jsonResponse({ version: "v1", sku_id: null, motivo, detalhe }, 200);

    if (candidatos.length === 0) {
      await audit(principal, entrada, null, "sem_skus");
      return semSku("sem_skus", "produto sem SKU ativo");
    }

    // 1. COR -------------------------------------------------------------
    // So filtra quando exigida E o SKU declara Cor; SKU sem Cor nao e
    // excluido (a cor do produto/alvejamento cobre, evita falso negativo).
    let cur = candidatos;
    if (entrada.cor_exigida) {
      const alvo = norm(entrada.cor_exigida);
      const comCor = cur.filter((s) => s.atributos?.["Cor"] != null);
      const casaCor = comCor.filter((s) => norm(s.atributos?.["Cor"]) === alvo);
      // Se algum SKU declara cor mas nenhum casa, e nao-atendimento por cor.
      if (comCor.length > 0 && casaCor.length === 0) {
        await audit(principal, entrada, null, "cor");
        return semSku("cor", `nenhum SKU na cor exigida (${entrada.cor_exigida})`);
      }
      // Mantem os que casam + os que nao declaram cor (cor implicita).
      cur = cur.filter(
        (s) => s.atributos?.["Cor"] == null || norm(s.atributos?.["Cor"]) === alvo,
      );
    }

    // 2. QUALIDADE -------------------------------------------------------
    // Aplica so se o produto tem escada (algum SKU com Qualidade). Alvo =
    // grau_exigido ?? comercial (mais barato). Se o alvo nao existe, sobe
    // pro proximo grau disponivel acima.
    const temEscada = cur.some((s) => s.atributos?.["Qualidade"] != null);
    if (temEscada) {
      const alvoOrdem = ORDEM_GRAU[entrada.grau_exigido ?? "comercial"];
      const grausDisp = [
        ...new Set(
          cur
            .map((s) => norm(s.atributos?.["Qualidade"]))
            .filter((g) => g in ORDEM_GRAU),
        ),
      ].sort((a, b) => ORDEM_GRAU[a] - ORDEM_GRAU[b]);
      const grauEscolhido = grausDisp.find((g) => ORDEM_GRAU[g] >= alvoOrdem);
      if (!grauEscolhido) {
        await audit(principal, entrada, null, "grau");
        return semSku("grau", `produto nao tem grau >= ${entrada.grau_exigido ?? "comercial"}`);
      }
      cur = cur.filter((s) => norm(s.atributos?.["Qualidade"]) === grauEscolhido);
    }

    // 3. DIMENSAO + ESCOLHA ----------------------------------------------
    // Item sem medida -> nao filtra: escolhe a menor area remanescente.
    const reqPar = parOrdenado(entrada.larg_mm, entrada.comp_mm);
    let escolhido: SkuRow;
    if (reqPar) {
      const [reqMax, reqMin] = reqPar;
      const areaReq = reqMax * reqMin;

      // Candidatos com medida (par ordenado + area). Sem medida nao concorre.
      const comDim: DimCand[] = [];
      for (const s of cur) {
        const par = parOrdenado(
          asNumber(s.dimensoes?.["largura_mm"]),
          asNumber(s.dimensoes?.["comprimento_mm"]),
        );
        if (par) comDim.push({ s, sMax: par[0], sMin: par[1], area: par[0] * par[1] });
      }

      let pick: DimCand | null = null;

      // MODO APROX: pode descer ao primeiro tamanho menor. Pega o MAIOR SKU
      // que nao ultrapassa o pedido em nenhum lado (mais perto por baixo).
      if (entrada.modo === "aprox") {
        const menores = comDim.filter((x) => x.sMax <= reqMax && x.sMin <= reqMin);
        if (menores.length > 0) {
          menores.sort((a, b) => (b.area - a.area) || a.s.codigo_sku.localeCompare(b.s.codigo_sku));
          pick = menores[0];
        }
        // Sem tamanho menor disponivel -> cai no fechamento por tamanho abaixo.
      }

      // MODO MINIMO (ou aprox sem menor): fecha pelo tamanho. Valido = area
      // do SKU >= area pedida E nenhum lado cai mais de 10% abaixo. A propria
      // area fechando joga a diferenca pro outro lado quando a grade trava um
      // lado. Escolha = MENOR area que fecha (= menos material).
      if (!pick) {
        const validos = comDim.filter(
          (x) => x.area >= areaReq && x.sMax >= reqMax * PISO_LADO && x.sMin >= reqMin * PISO_LADO,
        );
        if (validos.length === 0) {
          await audit(principal, entrada, null, "dimensao");
          return semSku("dimensao", `nenhum SKU fecha ${entrada.larg_mm}x${entrada.comp_mm}mm`);
        }
        validos.sort((a, b) => (a.area - b.area) || a.s.codigo_sku.localeCompare(b.s.codigo_sku));
        pick = validos[0];
      }
      escolhido = pick.s;
    } else {
      // Sem medida: menor area remanescente, estavel por codigo_sku.
      cur.sort((a, b) => {
        const d = areaSku(a.dimensoes) - areaSku(b.dimensoes);
        return d !== 0 ? d : a.codigo_sku.localeCompare(b.codigo_sku);
      });
      escolhido = cur[0];
    }

    await audit(principal, entrada, escolhido.id, null);
    return jsonResponse(
      {
        version: "v1",
        sku_id: escolhido.id,
        codigo_sku: escolhido.codigo_sku,
        justificativa: {
          cor: entrada.cor_exigida ?? null,
          grau: temEscada ? norm(escolhido.atributos?.["Qualidade"]) : null,
          dimensao: escolhido.dimensoes ?? null,
          exigido: reqPar ? { larg_mm: entrada.larg_mm, comp_mm: entrada.comp_mm, modo: entrada.modo } : null,
        },
      },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

async function audit(
  principal: V1Principal,
  entrada: Entrada,
  skuId: string | null,
  motivo: string | null,
): Promise<void> {
  await logSensitiveAction({
    tabela: "produto_skus",
    acao: "v1_selecionar_sku",
    registroId: skuId ?? entrada.produto_id,
    usuario: principalLabel(principal),
    dadosNovos: {
      via: principal.kind,
      escopo: ESCOPO,
      produto_id: entrada.produto_id,
      sku_id: skuId,
      motivo,
    },
  });
}

getEnv();

Deno.serve(handler);
