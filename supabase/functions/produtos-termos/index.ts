// =====================================================================
// Edge Function: produtos-termos  (Dominio E - criterios de cotacao)
// Geracao assistida dos "Termos de busca" (cotacao_diretrizes) de uma
// Linha inteira via LLM, em um clique.
//
// Rota:
//   POST /produtos-termos   { linha_id } -> { linha, produtos[], skus[] }
//
// A IA SUGERE, o humano VALIDA: le a Linha + Produtos + SKUs (nome e
// atributos) e devolve vocabulario de recall por nivel para o cockpit
// revisar e aplicar. NAO grava nada (alinhado ao SOM).
//
// Os termos sao vocabulario DESCRITIVO que ajuda a Lia a ENCONTRAR o item
// no edital (sinonimos, aplicacoes, materiais). Fronteira SEC-4: o prompt
// proibe preco/custo/margem/BOM/decisao/tolerancia (isso vive em Politica
// e Regras, nunca no embedding).
//
// Borda: handleCorsPreflight -> assertMethod(POST) -> requireAuthorizedUser
// -> validacao zod -> leitura do catalogo -> chamada OpenAI (JSON). O
// provedor/modelo/ativo vem de config_llm e a chave do Vault
// (LLM_OPENAI_API_KEY), administraveis em "Configuracoes da empresa".
// IA desativada ou sem chave -> 503 com causa clara.
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { getServiceSecret, LLM_OPENAI_API_KEY_NAME } from "../_shared/vault.ts";

const FUNCTION_SEGMENT = "produtos-termos";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 60_000;
// Teto por nivel: alinhado ao orcamento de 1 chunk/SKU (VERBATIM_MAX_CHARS).
const MAX_TERMO_CHARS = 600;

interface LlmConfig {
  modelo: string;
  apiKey: string;
}

/**
 * Resolve a configuracao da IA: le config_llm (ativo/modelo) e a chave do
 * Vault. IA desativada -> 503 ia_desativada; chave ausente -> 503
 * openai_nao_configurado. Nenhum segredo volta ao cliente.
 */
async function resolverConfigLlm(): Promise<LlmConfig> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("config_llm")
    .select("modelo, ativo")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_llm_query_failed", "falha ao consultar a config da IA");
  }

  const row = data as { modelo: string | null; ativo: boolean | null } | null;
  if (!row?.ativo) {
    throw new HttpError(
      503,
      "ia_desativada",
      "geracao indisponivel: ative a IA em Configuracoes da empresa",
    );
  }

  const apiKey = await getServiceSecret(LLM_OPENAI_API_KEY_NAME);
  if (!apiKey) {
    throw new HttpError(
      503,
      "openai_nao_configurado",
      "geracao indisponivel: configure a chave da IA em Configuracoes da empresa",
    );
  }

  return { modelo: row.modelo?.trim() || DEFAULT_MODEL, apiKey };
}

const gerarSchema = z.object({
  linha_id: z.string({ required_error: "linha_id e obrigatorio" }).uuid("linha_id invalido"),
});

interface LinhaRow {
  id: string;
  nome: string;
  descricao: string | null;
}
interface ProdutoRow {
  id: string;
  nome: string;
  descricao: string | null;
  atributos: Record<string, unknown> | null;
}
interface SkuRow {
  id: string;
  codigo_sku: string;
  produto_id: string;
  atributos: Record<string, unknown> | null;
}

interface CatalogoLinha {
  linha: LinhaRow;
  produtos: ProdutoRow[];
  skus: SkuRow[];
}

/** Carrega a Linha + Produtos ativos + SKUs ativos (service role). */
async function carregarCatalogo(linhaId: string): Promise<CatalogoLinha> {
  const service = createServiceClient();

  const { data: linha, error: linhaErr } = await service
    .from("produto_linhas")
    .select("id, nome, descricao")
    .eq("id", linhaId)
    .maybeSingle();
  if (linhaErr) {
    throw new HttpError(500, "linha_query_failed", "falha ao carregar a linha");
  }
  if (!linha) {
    throw new HttpError(404, "linha_nao_encontrada", "linha nao encontrada");
  }

  const { data: produtos, error: produtosErr } = await service
    .from("produtos")
    .select("id, nome, descricao, atributos")
    .eq("linha_id", linhaId)
    .eq("ativo", true)
    .order("nome");
  if (produtosErr) {
    throw new HttpError(500, "produtos_query_failed", "falha ao carregar os produtos da linha");
  }
  const produtosRows = (produtos ?? []) as ProdutoRow[];

  let skusRows: SkuRow[] = [];
  if (produtosRows.length > 0) {
    const { data: skus, error: skusErr } = await service
      .from("produto_skus")
      .select("id, codigo_sku, produto_id, atributos")
      .in("produto_id", produtosRows.map((p) => p.id))
      .eq("ativo", true)
      .order("codigo_sku");
    if (skusErr) {
      throw new HttpError(500, "skus_query_failed", "falha ao carregar os SKUs da linha");
    }
    skusRows = (skus ?? []) as SkuRow[];
  }

  return { linha: linha as LinhaRow, produtos: produtosRows, skus: skusRows };
}

/** Serializa um mapa de atributos jsonb em linhas "- chave: valor". */
function formatAtributos(atributos: Record<string, unknown> | null): string[] {
  if (!atributos) return [];
  return Object.entries(atributos)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([k, v]) => `  - ${k}: ${String(v)}`);
}

/** Monta o contexto textual da Linha inteira que o modelo recebe. */
function montarContexto(cat: CatalogoLinha): string {
  const linhas: string[] = [`LINHA: ${cat.linha.nome} (id=${cat.linha.id})`];
  if (cat.linha.descricao?.trim()) {
    linhas.push(`Descricao da linha: ${cat.linha.descricao.trim()}`);
  }

  for (const p of cat.produtos) {
    linhas.push("", `PRODUTO: ${p.nome} (id=${p.id})`);
    if (p.descricao?.trim()) linhas.push(`Descricao: ${p.descricao.trim()}`);
    const at = formatAtributos(p.atributos);
    if (at.length) linhas.push("Atributos do produto:", ...at);

    const skusDoProduto = cat.skus.filter((s) => s.produto_id === p.id);
    for (const s of skusDoProduto) {
      linhas.push(`  SKU: ${s.codigo_sku} (id=${s.id})`);
      const sat = formatAtributos(s.atributos);
      if (sat.length) linhas.push(...sat);
    }
  }

  return linhas.join("\n");
}

/** Prompt do sistema: vocabulario de recall por nivel, em JSON. */
const SYSTEM_PROMPT = [
  "Voce ajuda a DLH Industrial, fabricante que vende em licitacoes publicas, a indexar seu catalogo para busca.",
  "Sua tarefa: gerar TERMOS DE BUSCA (vocabulario de recall) que ajudem a encontrar cada item no texto de um edital.",
  "Os termos sao DESCRITIVOS: sinonimos, como o edital costuma nomear o item, aplicacoes, contexto de uso, materiais e variacoes.",
  "Hierarquia (heranca acumulativa - o nivel de baixo herda o texto dos de cima, entao NAO repita):",
  "- LINHA: vocabulario TRANSVERSAL, comum a TODOS os produtos da linha (categoria, aplicacao geral, normas). Nao cite termo que vale so para um produto.",
  "- PRODUTO: vocabulario do TIPO de produto (sinonimos, como o edital descreve, materiais e variacoes comuns).",
  "- SKU: gere SOMENTE se aquele SKU tiver um termo EXCLUSIVO que NAO esta nos atributos dele nem cabe no produto. Na duvida, NAO gere para o SKU.",
  "Regras rigidas:",
  "- Portugues do Brasil, frases curtas e diretas, sem listas e sem titulos. No maximo ~70 palavras por item.",
  "- Use termos que realmente aparecem em editais publicos brasileiros, incluindo sinonimos regionais.",
  "- NAO invente medidas, materiais ou especificacoes que nao foram informados.",
  "- PROIBIDO escrever preco, custo, margem, composicao de custo, decisao de participar/cotar ou tolerancia numerica. Apenas vocabulario de busca.",
  "Responda SOMENTE com JSON valido neste formato:",
  '{ "linha": "texto", "produtos": [ { "produto_id": "uuid", "termos": "texto" } ], "skus": [ { "sku_id": "uuid", "termos": "texto" } ] }',
  "Use exatamente os ids fornecidos no contexto. Omita produtos/skus para os quais nao ha termo util. O array skus pode ficar vazio.",
].join("\n");

interface LlmResposta {
  linha?: unknown;
  produtos?: Array<{ produto_id?: unknown; termos?: unknown }>;
  skus?: Array<{ sku_id?: unknown; termos?: unknown }>;
}

/** Chama a OpenAI (chat completions, JSON) e devolve o objeto parseado. */
async function gerarTermos(contexto: string, config: LlmConfig): Promise<LlmResposta> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelo,
        temperature: 0.5,
        max_tokens: 1600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: contexto },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new HttpError(504, "openai_timeout", "tempo de resposta excedido ao gerar os termos");
    }
    throw new HttpError(502, "openai_indisponivel", "falha ao contatar o provedor de IA");
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const status = res.status === 401 ? 503 : 502;
    const code = res.status === 401 ? "openai_auth_falhou" : "openai_erro";
    throw new HttpError(status, code, `provedor de IA respondeu ${res.status}`);
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const texto = payload.choices?.[0]?.message?.content?.trim();
  if (!texto) {
    throw new HttpError(502, "openai_resposta_vazia", "o provedor de IA nao retornou texto");
  }
  try {
    return JSON.parse(texto) as LlmResposta;
  } catch {
    throw new HttpError(502, "openai_json_invalido", "o provedor de IA retornou um JSON invalido");
  }
}

/** Normaliza texto sugerido: trim + teto de caracteres. Vazio -> null. */
function limparTermo(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;
  return t.length > MAX_TERMO_CHARS ? t.slice(0, MAX_TERMO_CHARS).trim() : t;
}

/**
 * Cruza a resposta do LLM com o catalogo real: descarta ids inventados,
 * limpa textos e enriquece com nome/codigo para o preview do cockpit.
 */
function montarSugestao(cat: CatalogoLinha, llm: LlmResposta) {
  const produtoById = new Map(cat.produtos.map((p) => [p.id, p]));
  const skuById = new Map(cat.skus.map((s) => [s.id, s]));
  const produtoNomeById = new Map(cat.produtos.map((p) => [p.id, p.nome]));

  const linhaTexto = limparTermo(llm.linha);

  const produtos = (llm.produtos ?? [])
    .map((p) => {
      const id = typeof p.produto_id === "string" ? p.produto_id : "";
      const prod = produtoById.get(id);
      const texto = limparTermo(p.termos);
      if (!prod || !texto) return null;
      return { escopo_id: prod.id, nome: prod.nome, texto };
    })
    .filter((x): x is { escopo_id: string; nome: string; texto: string } => x !== null);

  const skus = (llm.skus ?? [])
    .map((s) => {
      const id = typeof s.sku_id === "string" ? s.sku_id : "";
      const sku = skuById.get(id);
      const texto = limparTermo(s.termos);
      if (!sku || !texto) return null;
      return {
        escopo_id: sku.id,
        codigo_sku: sku.codigo_sku,
        produto_nome: produtoNomeById.get(sku.produto_id) ?? "",
        texto,
      };
    })
    .filter(
      (x): x is { escopo_id: string; codigo_sku: string; produto_nome: string; texto: string } =>
        x !== null,
    );

  return {
    linha: linhaTexto
      ? { escopo_id: cat.linha.id, nome: cat.linha.nome, texto: linhaTexto }
      : null,
    produtos,
    skus,
  };
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["POST"]);
    await requireAuthorizedUser(req);

    const input = await parseJsonBody(req, gerarSchema);
    const config = await resolverConfigLlm();
    const catalogo = await carregarCatalogo(input.linha_id);
    if (catalogo.produtos.length === 0) {
      throw new HttpError(
        422,
        "linha_sem_produtos",
        "a linha nao tem produtos ativos para gerar termos",
      );
    }

    const llm = await gerarTermos(montarContexto(catalogo), config);
    return jsonResponse(montarSugestao(catalogo, llm), 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
