// =====================================================================
// Edge Function: documentos-ingerir  ->  POST /documentos/ingerir
// Endpoint de PUSH do extrator de NUVEM (GitHub Actions / runner Node).
//
//   CAMADA 1 do pipeline de documentos. O runner Node (onde o Tika vive)
//   obtem os bytes por adaptador de fonte, extrai o TEXTO e empurra para
//   ca. Este Edge e o dono da PERSISTENCIA: dedup global, gravacao do
//   texto e indexacao (chunks/embeddings) reusando o motor existente
//   (generateAndStoreMemoriaChunks, origem='documento'). EMBEDDINGS_ENDPOINT
//   e o service_role so existem no Edge -> a indexacao mora aqui, nao no
//   runner (mesma divisao do nomus-ingerir).
//
//   DEDUP (decisao Fabio 2026-06-08): documento e entidade unica; mesma
//   licitacao chega por N fontes -> 1 documento, N vinculos. Chave canonica
//   = hash_texto_normalizado; sha256_bytes = atalho quando nao ha texto.
//   Quem chega primeiro EXTRAI e grava; o resto so LINKA (status='herdado').
//
//   NAO-BLOQUEIO: o texto grava mesmo com embedding OFF (status_indexacao
//   fica 'pendente', igual avisos); ligar bge-m3 depois + reindexar.
//
//   - Autentica por chamada interna: Bearer service_role OU X-Cron-Secret.
//   - action='pendentes' (read): lista vinculos a extrair (com ref_obtencao).
//   - default (push): processa os resultados de extracao do runner.
//   - Falha isolada por item NAO derruba o lote; vira status='erro' no vinculo.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, matchesCronSecret } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { type EmbeddingProvider, generateAndStoreMemoriaChunks } from "../_shared/embeddings.ts";
import { loadConfigIndexacao, resolveEmbeddingProvider } from "../_shared/indexacao.ts";

const DEFAULT_PENDENTES_LIMITE = 50;
const MAX_PENDENTES_LIMITE = 500;

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Resultado de extracao de um anexo, empurrado pelo runner. */
interface ResultadoExtracao {
  vinculo_id: string;
  ok: boolean;
  erro?: string;
  nome_arquivo?: string | null;
  extensao?: string | null;
  tamanho_bytes?: number | null;
  sha256_bytes?: string | null;
  hash_texto_normalizado?: string | null;
  texto?: string | null;
  usou_ocr?: boolean;
  via?: string | null;
  /**
   * Sinalizado pelo passo RAPIDO (OCR off) quando o anexo so daria texto via
   * OCR (PDF escaneado/imagem sem camada de texto). Em vez de extrair caro
   * inline, o vinculo vai para a fila 'precisa_ocr' que o passo OCR dedicado
   * drena. Ignorado no modo ocr (que ja roda com OCR ligado).
   */
  precisa_ocr?: boolean;
  /**
   * Sinalizado pelo runner quando a falha e TERMINAL (a fonte removeu o arquivo
   * ou o conteudo e permanentemente nao-processavel). Marca status='inobtenivel'
   * em vez de 'erro' -> sai da fila e NAO reprocessa (decisao Fabio 2026-06-16).
   */
  inobtenivel?: boolean;
  /** Classificacao do tipo (gancho camada 2); opcional nesta fase. */
  tipo_documento?: string | null;
}

interface IngerirInput {
  action?: string;
  limite?: number;
  /** "rapido" (default): drena status='pendente'. "ocr": drena 'precisa_ocr'. */
  modo?: "rapido" | "ocr";
  documentos: ResultadoExtracao[];
}

interface ItemResultado {
  vinculo_id: string;
  // 'pendente' = falhou mas ainda abaixo do teto de tentativas: re-enfileirado
  // para o proprio run reprocessar (auto-retry), nao caiu em card terminal.
  estado: "novo" | "herdado" | "erro" | "precisa_ocr" | "inobtenivel" | "pendente";
  documento_id?: string;
  indexado?: boolean;
}

// ---------------------------------------------------------------------
// Autenticacao da chamada interna (service_role OU X-Cron-Secret no Vault)
// ---------------------------------------------------------------------

async function assertInternalAuth(req: Request): Promise<void> {
  const bearer = extractBearerToken(req);
  const env = getEnv();
  if (bearer && timingSafeEqual(bearer, env.serviceRoleKey)) return;

  if (await matchesCronSecret(req)) return;

  throw new HttpError(401, "cron_unauthorized", "chamada interna nao autorizada");
}

// ---------------------------------------------------------------------
// Parse do corpo
// ---------------------------------------------------------------------

async function parseInput(req: Request): Promise<IngerirInput> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "corpo_invalido", "corpo da requisicao nao e JSON valido");
  }
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "corpo_invalido", "corpo da requisicao ausente");
  }
  const o = body as Record<string, unknown>;
  const action = typeof o.action === "string" ? o.action : undefined;
  const limiteRaw = typeof o.limite === "number" ? o.limite : NaN;
  const modo = o.modo === "ocr" ? "ocr" : "rapido";

  if (!action && !Array.isArray(o.documentos)) {
    throw new HttpError(422, "documentos_ausentes", "campo 'documentos' (array) e obrigatorio");
  }

  const documentos = Array.isArray(o.documentos)
    ? o.documentos
      .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
      .map(normalizeResultado)
      .filter((d): d is ResultadoExtracao => d !== null)
    : [];

  return {
    action,
    modo,
    limite: Number.isFinite(limiteRaw) && limiteRaw > 0
      ? Math.min(Math.floor(limiteRaw), MAX_PENDENTES_LIMITE)
      : undefined,
    documentos,
  };
}

function normalizeResultado(o: Record<string, unknown>): ResultadoExtracao | null {
  const vinculoId = typeof o.vinculo_id === "string" ? o.vinculo_id : null;
  if (!vinculoId) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    vinculo_id: vinculoId,
    ok: o.ok === true,
    erro: str(o.erro) ?? undefined,
    nome_arquivo: str(o.nome_arquivo),
    extensao: str(o.extensao),
    tamanho_bytes: num(o.tamanho_bytes),
    sha256_bytes: str(o.sha256_bytes),
    hash_texto_normalizado: str(o.hash_texto_normalizado),
    texto: typeof o.texto === "string" ? o.texto : null,
    usou_ocr: o.usou_ocr === true,
    via: str(o.via),
    precisa_ocr: o.precisa_ocr === true,
    inobtenivel: o.inobtenivel === true,
    tipo_documento: str(o.tipo_documento),
  };
}

// ---------------------------------------------------------------------
// action='pendentes': lista vinculos a extrair (status='pendente').
// ---------------------------------------------------------------------

/**
 * Lista vinculos a extrair (status='pendente'), opcionalmente restritos a uma
 * allowlist de fontes (config_extracao.fontes_habilitadas). Filtrar AQUI (na
 * origem da fila, nao no runner) e o que torna a selecao de fontes efetiva sem
 * loop: vinculos de fonte desabilitada simplesmente nao saem como pendentes.
 */
async function listarPendentes(
  service: ServiceClient,
  limite: number,
  fontes: string[] | null,
  modo: "rapido" | "ocr",
): Promise<unknown[]> {
  // rapido drena a fila normal; ocr drena so o que o passo rapido marcou como
  // 'precisa_ocr' (PDF escaneado/imagem), isolando o OCR caro num run dedicado.
  const statusFila = modo === "ocr" ? "precisa_ocr" : "pendente";
  let query = service
    .from("documento_vinculos")
    .select("id, fonte, registro_origem_id, nome_anexo, ref_obtencao")
    .eq("status_extracao", statusFila);
  if (fontes && fontes.length > 0) {
    query = query.in("fonte", fontes);
  }
  // Fairness do auto-retry: quem ja falhou (tentativas maior) vai pro FIM da
  // fila, p/ um anexo problematico nao monopolizar o run e travar os bons.
  const { data, error } = await query
    .order("tentativas_extracao", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limite);
  if (error) {
    throw new HttpError(500, "pendentes_query_failed", "falha ao listar vinculos pendentes");
  }
  return data ?? [];
}

/**
 * Le a config_extracao (singleton GLOBAL) e devolve ao runner junto dos
 * pendentes. O runner do Actions NAO tem service_role (so X-Cron-Secret),
 * entao a leitura dos parametros administraveis do cockpit passa por aqui
 * (decisao Fabio: "runner le config no inicio do job"). Camel-case para o
 * extrator consumir direto. Null => extrator usa CONFIG_PADRAO.
 */
async function loadConfigExtracao(service: ServiceClient): Promise<Record<string, unknown> | null> {
  const { data, error } = await service
    .from("config_extracao")
    .select(
      "ocr_estrategia, ocr_idioma, tamanho_max_bytes, timeout_ms, extensoes_habilitadas, fontes_habilitadas, lote_tamanho, pausa_lote_ms",
    )
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const c = data as Record<string, unknown>;
  return {
    ocrEstrategia: c.ocr_estrategia,
    ocrIdioma: c.ocr_idioma,
    tamanhoMaxBytes: c.tamanho_max_bytes,
    timeoutMs: c.timeout_ms,
    extensoesHabilitadas: c.extensoes_habilitadas,
    fontesHabilitadas: c.fontes_habilitadas,
    loteTamanho: c.lote_tamanho,
    pausaLoteMs: c.pausa_lote_ms,
  };
}

/**
 * Le o teto de tentativas (config_extracao.tentativas_max, default 3) que
 * governa o auto-retry da extracao: abaixo dele a falha volta 'pendente' e o
 * proprio run reprocessa; ao atinge-lo o vinculo cai em card terminal.
 */
async function loadTetoExtracao(service: ServiceClient): Promise<number> {
  const { data, error } = await service
    .from("config_extracao")
    .select("tentativas_max")
    .limit(1)
    .maybeSingle();
  if (error || !data) return 3;
  const teto = (data as { tentativas_max?: number }).tentativas_max;
  return typeof teto === "number" && teto >= 1 ? teto : 3;
}

// ---------------------------------------------------------------------
// Dedup: acha documento existente pela chave canonica (hash do texto) ou,
// quando nao ha texto, pelo sha256 dos bytes. Retorna id ou null.
// ---------------------------------------------------------------------

async function acharDocumentoExistente(
  service: ServiceClient,
  r: ResultadoExtracao,
): Promise<string | null> {
  if (r.hash_texto_normalizado) {
    const { data, error } = await service
      .from("documentos")
      .select("id")
      .eq("hash_texto_normalizado", r.hash_texto_normalizado)
      .maybeSingle();
    if (error) throw new HttpError(500, "dedup_query_failed", "falha no dedup por texto");
    if (data) return String((data as { id: string }).id);
    return null;
  }
  if (r.sha256_bytes) {
    const { data, error } = await service
      .from("documentos")
      .select("id")
      .eq("sha256_bytes", r.sha256_bytes)
      .limit(1)
      .maybeSingle();
    if (error) throw new HttpError(500, "dedup_query_failed", "falha no dedup por bytes");
    if (data) return String((data as { id: string }).id);
  }
  return null;
}

// ---------------------------------------------------------------------
// Processa um resultado de extracao: dedup -> grava/linka -> indexa.
// ---------------------------------------------------------------------

/**
 * Gating por fonte no continuo (config_indexacao.fontes_habilitadas): so
 * indexa inline se a fonte DESTE vinculo estiver habilitada. fontes=null =>
 * todas habilitadas (sem consulta). Espelha o gating do backfill, que filtra
 * por documento_vinculos.fonte; aqui o vinculo e conhecido pelo id.
 */
async function fonteHabilitada(
  service: ServiceClient,
  vinculoId: string,
  fontes: string[] | null,
): Promise<boolean> {
  if (!fontes) return true;
  const { data } = await service
    .from("documento_vinculos")
    .select("fonte")
    .eq("id", vinculoId)
    .maybeSingle();
  return !!data && fontes.includes((data as { fonte: string }).fonte);
}

async function processarResultado(
  service: ServiceClient,
  provider: EmbeddingProvider | undefined,
  fontesIndex: string[] | null,
  teto: number,
  r: ResultadoExtracao,
): Promise<ItemResultado> {
  // Extracao falhou no runner: AUTO-RETRY ate o teto. A RPC incrementa
  // tentativas_extracao e decide o destino: abaixo do teto volta 'pendente'
  // (o proprio run re-busca a fila e reprocessa); ao atingir o teto cai em
  // card terminal — 'inobtenivel' (fonte removeu / nao-processavel) ou 'erro'
  // (transitorio que esgotou). NAO grava direto: a RPC concentra a regra.
  if (!r.ok) {
    const { data, error } = await service.rpc("marcar_falha_extracao", {
      p_id: r.vinculo_id,
      p_teto: teto,
      p_terminal: r.inobtenivel === true,
      p_erro: r.erro ?? "falha de extracao no runner",
    });
    // Fallback defensivo: se a RPC falhar, marca o destino terminal direto p/
    // o vinculo nao ficar preso fora da fila sem registro de erro.
    if (error) {
      const estado = r.inobtenivel ? "inobtenivel" : "erro";
      await service
        .from("documento_vinculos")
        .update({ status_extracao: estado, erro: r.erro ?? "falha de extracao no runner" })
        .eq("id", r.vinculo_id);
      return { vinculo_id: r.vinculo_id, estado };
    }
    const estado = (data as ItemResultado["estado"]) ?? "erro";
    return { vinculo_id: r.vinculo_id, estado };
  }

  // Passo rapido detectou que o anexo so daria texto via OCR: enfileira para o
  // passo OCR dedicado em vez de extrair caro inline. Nao grava documento.
  if (r.precisa_ocr) {
    await service
      .from("documento_vinculos")
      .update({ status_extracao: "precisa_ocr", erro: null, tentativas_extracao: 0 })
      .eq("id", r.vinculo_id);
    return { vinculo_id: r.vinculo_id, estado: "precisa_ocr" };
  }

  // Dedup: se ja existe o documento, so LINKA (herdado), nao reextrai/reindexar.
  const existenteId = await acharDocumentoExistente(service, r);
  if (existenteId) {
    await service
      .from("documento_vinculos")
      .update({ documento_id: existenteId, status_extracao: "herdado", erro: null, tentativas_extracao: 0 })
      .eq("id", r.vinculo_id);
    return { vinculo_id: r.vinculo_id, estado: "herdado", documento_id: existenteId };
  }

  // Documento novo: grava o texto (status_indexacao='pendente' ate indexar).
  let documentoId: string;
  const { data: ins, error: insError } = await service
    .from("documentos")
    .insert({
      nome_arquivo: r.nome_arquivo,
      extensao: r.extensao,
      tamanho_bytes: r.tamanho_bytes,
      sha256_bytes: r.sha256_bytes,
      hash_texto_normalizado: r.hash_texto_normalizado,
      texto: r.texto,
      usou_ocr: r.usou_ocr ?? false,
      via: r.via,
      tipo_documento: r.tipo_documento,
      status_indexacao: "pendente",
    })
    .select("id")
    .single();

  if (insError) {
    // Corrida: outro lote inseriu o mesmo hash entre o dedup e o insert
    // (unique parcial em hash_texto_normalizado). Re-resolve e LINKA.
    if (insError.code === "23505") {
      const reId = await acharDocumentoExistente(service, r);
      if (reId) {
        await service
          .from("documento_vinculos")
          .update({ documento_id: reId, status_extracao: "herdado", erro: null, tentativas_extracao: 0 })
          .eq("id", r.vinculo_id);
        return { vinculo_id: r.vinculo_id, estado: "herdado", documento_id: reId };
      }
    }
    throw new HttpError(500, "documento_insert_failed", "falha ao gravar o documento");
  }
  documentoId = String((ins as { id: string }).id);

  // Liga o vinculo ao documento recem-criado (este extraiu).
  await service
    .from("documento_vinculos")
    .update({ documento_id: documentoId, status_extracao: "extraido", erro: null, tentativas_extracao: 0 })
    .eq("id", r.vinculo_id);

  // Indexacao (chunks/embeddings) reusa o motor agnostico. NAO bloqueia: se a
  // indexacao esta OFF (ou a fonte deste vinculo nao esta habilitada), o texto
  // ja esta salvo e fica status_indexacao='pendente' para o backfill cobrir.
  let indexado = false;
  if (
    provider && r.texto && r.texto.trim() !== "" &&
    (await fonteHabilitada(service, r.vinculo_id, fontesIndex))
  ) {
    try {
      await generateAndStoreMemoriaChunks(service, {
        origem: "documento",
        tipo: r.tipo_documento ?? null,
        registroId: documentoId,
        verbatim: r.texto,
        provider,
      });
      await service
        .from("documentos")
        .update({ status_indexacao: "concluida" })
        .eq("id", documentoId);
      indexado = true;
    } catch (err) {
      // Indexacao e best-effort: deixa 'pendente' para reindexar depois.
      console.error("[documentos-ingerir] falha ao indexar documento", {
        documentoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { vinculo_id: r.vinculo_id, estado: "novo", documento_id: documentoId, indexado };
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    await assertInternalAuth(req);

    const input = await parseInput(req);
    const service = createServiceClient();

    if (input.action === "pendentes") {
      const limite = input.limite ?? DEFAULT_PENDENTES_LIMITE;
      // Le a config primeiro: a allowlist de fontes restringe a fila na origem.
      const config = await loadConfigExtracao(service);
      const fontes = Array.isArray(config?.fontesHabilitadas)
        ? (config.fontesHabilitadas as string[])
        : null;
      const modo = input.modo ?? "rapido";
      const pendentes = await listarPendentes(service, limite, fontes, modo);
      return jsonResponse({ pendentes, config, modo, total: pendentes.length }, 200);
    }

    // Gating da indexacao continua pela config administravel (master switch +
    // fontes). OFF => provider undefined: grava o texto 'pendente' e o backfill
    // (documentos-indexar) cobre depois. A chave OpenAI vem do Vault.
    const config = await loadConfigIndexacao(service);
    const provider = config?.ativo ? await resolveEmbeddingProvider() : undefined;
    const fontesIndex = config?.fontesHabilitadas ?? null;
    // Teto do auto-retry: falha re-tenta ate o teto no proprio run antes de
    // virar card terminal (administravel via config_extracao.tentativas_max).
    const teto = await loadTetoExtracao(service);

    const resultados: ItemResultado[] = [];
    let novos = 0;
    let herdados = 0;
    let erros = 0;
    let precisaOcr = 0;
    let inobtenivel = 0;
    let reenfileirados = 0;

    for (const r of input.documentos) {
      try {
        const out = await processarResultado(service, provider, fontesIndex, teto, r);
        resultados.push(out);
        if (out.estado === "novo") novos += 1;
        else if (out.estado === "herdado") herdados += 1;
        else if (out.estado === "precisa_ocr") precisaOcr += 1;
        else if (out.estado === "inobtenivel") inobtenivel += 1;
        else if (out.estado === "pendente") reenfileirados += 1;
        else erros += 1;
      } catch (err) {
        // Falha ao persistir = transitorio: passa pelo MESMO auto-retry (volta
        // 'pendente' abaixo do teto, 'erro' ao esgotar) p/ nao queimar o anexo
        // numa falha isolada de gravacao. terminal=false (nunca inobtenivel).
        const out = await processarResultado(service, provider, fontesIndex, teto, {
          ...r,
          ok: false,
          inobtenivel: false,
          erro: err instanceof Error ? err.message : "falha ao persistir documento",
        });
        resultados.push(out);
        if (out.estado === "pendente") reenfileirados += 1;
        else if (out.estado === "inobtenivel") inobtenivel += 1;
        else erros += 1;
      }
    }

    return jsonResponse(
      {
        recebidos: input.documentos.length,
        novos,
        herdados,
        erros,
        precisa_ocr: precisaOcr,
        inobtenivel,
        reenfileirados,
        resultados,
      },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: "documentos-ingerir" });
  }
}

getEnv();

Deno.serve(handler);
