// =====================================================================
// Edge Function: produtos-descricao  (Dominio A - cadastro)
// Geracao assistida da descricao comercial de um Produto via LLM.
//
// Rota:
//   POST /produtos-descricao   { nome, descricao?, atributos? } -> { descricao }
//
// A IA SUGERE, o humano VALIDA: esta funcao apenas devolve um texto
// reescrito (tom comercial/profissional) a partir do que o usuario ja tem;
// NAO grava nada. O cockpit mostra a sugestao num preview e so aplica/salva
// por acao explicita do usuario (alinhado ao SOM).
//
// Borda: handleCorsPreflight -> assertMethod(POST) -> requireAuthorizedUser
// -> validacao zod -> chamada OpenAI. O provedor/modelo/ativo vem da tabela
// config_llm e a chave do Vault (LLM_OPENAI_API_KEY), ambos administraveis
// pela tela "Configuracoes da empresa" (card de IA), sem hardcode. IA
// desativada ou sem chave -> 503 com causa clara.
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { getServiceSecret, LLM_OPENAI_API_KEY_NAME } from "../_shared/vault.ts";

const FUNCTION_SEGMENT = "produtos-descricao";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PALAVRAS = 40;

/** Teto de tokens a partir do limite de palavras (margem p/ pt-BR). */
function tetoTokens(maxPalavras: number): number {
  return Math.ceil(maxPalavras * 2.2) + 16;
}

interface LlmConfig {
  modelo: string;
  apiKey: string;
  maxPalavras: number;
}

/**
 * Resolve a configuracao da IA: le config_llm (ativo/modelo/tamanho) e a
 * chave do Vault. IA desativada -> 503 ia_desativada; chave ausente -> 503
 * openai_nao_configurado. Nenhum segredo volta ao cliente.
 */
async function resolverConfigLlm(): Promise<LlmConfig> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("config_llm")
    .select("modelo, ativo, descricao_max_palavras")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_llm_query_failed", "falha ao consultar a config da IA");
  }

  const row = data as {
    modelo: string | null;
    ativo: boolean | null;
    descricao_max_palavras: number | null;
  } | null;
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

  return {
    modelo: row.modelo?.trim() || DEFAULT_MODEL,
    apiKey,
    maxPalavras: row.descricao_max_palavras ?? DEFAULT_MAX_PALAVRAS,
  };
}

const gerarSchema = z.object({
  nome: z.string({ required_error: "nome e obrigatorio" }).trim().min(1, "informe o nome do produto"),
  descricao: z.string().trim().optional(),
  atributos: z.record(z.unknown()).optional(),
});

/** Monta o contexto que o modelo recebe a partir do produto informado. */
function montarContexto(input: z.infer<typeof gerarSchema>): string {
  const linhas: string[] = [`Produto: ${input.nome}`];

  if (input.descricao && input.descricao.trim() !== "") {
    linhas.push(`Descricao atual: ${input.descricao.trim()}`);
  } else {
    linhas.push("Descricao atual: (vazia)");
  }

  const atributos = input.atributos ?? {};
  const pares = Object.entries(atributos)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([k, v]) => `- ${k}: ${String(v)}`);
  if (pares.length > 0) {
    linhas.push("Atributos:", ...pares);
  }

  return linhas.join("\n");
}

/** Prompt do sistema com o limite de palavras configurado no cockpit. */
function buildSystemPrompt(maxPalavras: number): string {
  return [
    "Voce e redator comercial da DLH Industrial, fabricante que vende em licitacoes publicas.",
    "Reescreva a descricao do produto em portugues do Brasil, com tom comercial e profissional.",
    "Objetivo: destacar uso, beneficio e diferencial competitivo de forma clara e direta.",
    "Regras:",
    `- Use no maximo ${maxPalavras} palavras, em texto corrido, sem listas e sem titulos.`,
    "- NAO invente especificacoes tecnicas, medidas ou materiais que nao foram informados.",
    "- Nao use superlativos vazios nem promessas exageradas.",
    "- Retorne APENAS o texto da descricao, sem aspas e sem comentarios.",
  ].join("\n");
}

/** Chama a OpenAI (chat completions) e devolve o texto gerado. */
async function gerarDescricao(contexto: string, config: LlmConfig): Promise<string> {
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
        temperature: 0.7,
        max_tokens: tetoTokens(config.maxPalavras),
        messages: [
          { role: "system", content: buildSystemPrompt(config.maxPalavras) },
          { role: "user", content: contexto },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new HttpError(504, "openai_timeout", "tempo de resposta excedido ao gerar a descricao");
    }
    throw new HttpError(502, "openai_indisponivel", "falha ao contatar o provedor de IA");
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const status = res.status === 401 ? 503 : 502;
    const code = res.status === 401 ? "openai_nao_configurado" : "openai_erro";
    throw new HttpError(status, code, `provedor de IA respondeu ${res.status}`);
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const texto = payload.choices?.[0]?.message?.content?.trim();
  if (!texto) {
    throw new HttpError(502, "openai_resposta_vazia", "o provedor de IA nao retornou texto");
  }
  return texto;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["POST"]);
    await requireAuthorizedUser(req);

    const input = await parseJsonBody(req, gerarSchema);
    const config = await resolverConfigLlm();
    const descricao = await gerarDescricao(montarContexto(input), config);

    return jsonResponse({ descricao }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
