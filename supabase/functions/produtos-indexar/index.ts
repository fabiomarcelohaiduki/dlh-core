// =====================================================================
// Edge Function: produtos-indexar  ->  POST /produtos-indexar
// BACKFILL one-shot da indexacao do CATALOGO no escopo produto-cotacao.
//
// Problema: produto_skus.diretriz_producao = null em todos os 246 SKUs
// cadastrados antes da indexacao ser ligada -> memoria_chunks com
// tipo='produto-cotacao' fica vazio -> triagem retorna produtos_candidatos=[]
// -> invariante E12 rebaixa todos os avisos para 'duvida'.
//
// Solucao: para cada SKU ativo constroi um verbatim rico a partir dos
// dados do catalogo (linha.nome + produto.nome + produto.descricao +
// sku.codigo_sku + sku.atributos) e indexa em memoria_chunks com
// origem='produto', tipo='produto-cotacao', registro_id=sku.id.
//
// Usa resolveEmbeddingProvider() (OpenAI text-embedding-3-small/1024 dims
// via Vault) para garantir dimensao correta em memoria_chunks, identica
// a da perna de processos. Passa o provider a syncMemoriaChunks para
// contornar o gate EMBEDDINGS_ENDPOINT (nao usado nesta perna).
//
// Auth: service_role Bearer OU X-Cron-Secret (chamada interna/cron) OU
// usuario autorizado via JWT (botao manual no cockpit). verify_jwt=false em
// config.toml (mesma razao dos outros backfills).
// Sem lock: escopo produto-cotacao e isolado de documentos/processos.
//
// Escopo opcional: body { linha_id } reindexa SOMENTE os SKUs daquela linha
// (cabe no gateway, retorna sincrono). Sem linha_id reindexa todos os SKUs
// ativos (uso do cron/backfill). O cockpit sempre envia linha_id (o botao
// "reindexar tudo" itera as linhas no cliente).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, matchesCronSecret, requireAuthorizedUser } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { resolveEmbeddingProvider } from "../_shared/indexacao.ts";
import { syncMemoriaChunks } from "../_shared/memoria-reindex.ts";

/** Escopo fixo do indice de memoria do catalogo. */
const CHUNK_ORIGEM = "produto";
const CHUNK_TIPO = "produto-cotacao";

/** Pausa entre SKUs para aliviar a OpenAI (ms). */
const PAUSA_MS = 200;

/**
 * Teto de chars do verbatim para garantir 1 CHUNK por SKU (chunkText fatia em
 * ~2000 chars). A ancora (nome+linha+descricao+codigo+atributos) vem primeiro
 * e e preservada; diretrizes preenchem o restante do orcamento e sao cortadas
 * se estourarem — evita diluir a ancora em multiplos chunks.
 */
const VERBATIM_MAX_CHARS = 1900;

/** Linha de SKU retornada pelo join. */
interface SkuRow {
  sku_id: string;
  codigo_sku: string;
  atributos: Record<string, unknown> | null;
  produto_nome: string;
  produto_descricao: string | null;
  linha_nome: string;
  /**
   * Diretrizes de cotacao aplicaveis (cotacao_diretrizes), resolvidas no nivel
   * LINHA + PRODUTO. Texto DESCRITIVO (RF-24, "indexavel") -> entra no embedding
   * para ampliar recall. NAO confundir com politica de participacao (decisao
   * deterministica, fica fora do vetor).
   */
  diretrizes: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Converte os atributos JSONB do SKU (objeto chave->valor) numa string
 * legivel para indexacao semantica. Ex.: "Cor: Laranja. Material: Algodao."
 * Exclui valores null/vazios.
 */
function atributosParaTexto(atributos: Record<string, unknown> | null): string {
  if (!atributos || typeof atributos !== "object") return "";
  return Object.entries(atributos)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([k, v]) => `${k}: ${String(v).trim()}`)
    .join(". ");
}

/**
 * Constroi o verbatim indexavel de um SKU a partir dos dados do catalogo.
 * Formato: "{produto_nome}. Linha: {linha_nome}. {descricao} Codigo: {sku}. {atributos}."
 */
function buildVerbatim(row: SkuRow): string {
  const partes: string[] = [];

  // Nome do produto + linha (ancora semantica principal).
  partes.push(`${row.produto_nome}. Linha: ${row.linha_nome}.`);

  // Descricao do produto (texto livre, rico semanticamente).
  const desc = (row.produto_descricao ?? "").trim();
  if (desc) partes.push(desc);

  // Codigo do SKU (busca por referencia exata).
  partes.push(`Codigo: ${row.codigo_sku}.`);

  // Atributos tecnicos (dimensoes, material, gramatura, etc.).
  const attrs = atributosParaTexto(row.atributos);
  if (attrs) partes.push(attrs + ".");

  // Ancora (nome+linha+descricao+codigo+atributos): preservada integralmente.
  const ancora = partes.join(" ").trim();

  // Diretrizes de cotacao (linha + produto): texto descritivo que aproxima o
  // vocabulario do edital ao do produto (ex.: aplicacoes, normas, sinonimos).
  // Preenchem o orcamento restante ate VERBATIM_MAX_CHARS (1 chunk por SKU).
  let verbatim = ancora;
  for (const d of row.diretrizes) {
    const t = d.trim();
    if (!t) continue;
    const frag = ` Diretriz: ${t}${t.endsWith(".") ? "" : "."}`;
    if (verbatim.length + frag.length > VERBATIM_MAX_CHARS) {
      // Cabe um pedaco? Trunca a diretriz no orcamento; senao para.
      const espaco = VERBATIM_MAX_CHARS - verbatim.length;
      if (espaco > 20) verbatim += frag.slice(0, espaco);
      break;
    }
    verbatim += frag;
  }

  return verbatim.trim();
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autenticacao: service_role Bearer OU X-Cron-Secret (interno/cron) OU,
    // na falta dos dois, usuario autorizado via JWT (disparo manual do cockpit).
    const bearer = extractBearerToken(req);
    const env = getEnv();
    const isServiceRole = bearer && timingSafeEqual(bearer, env.serviceRoleKey);
    const isCron = await matchesCronSecret(req);
    let email = "system:produtos-indexar";
    if (!isServiceRole && !isCron) {
      // requireAuthorizedUser lanca 401 quando o JWT e invalido/nao autorizado.
      const ctx = await requireAuthorizedUser(req);
      email = ctx.email;
    }

    // Escopo opcional por linha (body { linha_id }). Sem corpo (cron) -> todos.
    let linhaId: string | null = null;
    try {
      const body = await req.json();
      const v = (body as { linha_id?: unknown })?.linha_id;
      if (typeof v === "string" && v.trim()) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())) {
          throw new HttpError(400, "linha_id_invalido", "linha_id invalido");
        }
        linhaId = v.trim();
      }
    } catch (err) {
      // Repropaga erro de validacao; ignora corpo ausente/nao-JSON (cron).
      if (err instanceof HttpError) throw err;
    }

    const service = createServiceClient();

    // Provider OpenAI (1024 dims) via Vault — mesmo da perna de processos.
    // Falha aqui se a chave nao estiver configurada (503).
    const provider = await resolveEmbeddingProvider();

    // Busca todos os SKUs ativos com dados de produto e linha (com ids para
    // resolver diretrizes por escopo).
    // Escopo por linha: resolve os produto_id da linha primeiro e filtra os SKUs
    // por .in("produto_id", ...) (padrao estabelecido em produtos-termos). Evita
    // filtro em coluna de relacao aninhada, cuja falha seria silenciosa e
    // reindexaria o catalogo inteiro.
    let produtoIdsDaLinha: string[] | null = null;
    if (linhaId) {
      const { data: produtosLinha, error: produtosErr } = await service
        .from("produtos")
        .select("id")
        .eq("linha_id", linhaId)
        .eq("ativo", true);
      if (produtosErr) {
        throw new Error(`falha ao listar produtos da linha: ${produtosErr.message}`);
      }
      produtoIdsDaLinha = (produtosLinha ?? []).map((p) => (p as { id: string }).id);
    }

    let skus: unknown[] = [];
    // Linha sem produtos ativos -> nada a indexar (evita .in([]) que retorna tudo).
    if (!linhaId || (produtoIdsDaLinha && produtoIdsDaLinha.length > 0)) {
      let skusQuery = service
        .from("produto_skus")
        .select(`
        id,
        codigo_sku,
        atributos,
        produtos!inner(
          id,
          nome,
          descricao,
          produto_linhas!produtos_linha_id_fkey!inner(id, nome)
        )
      `)
        .eq("ativo", true);
      if (produtoIdsDaLinha) {
        skusQuery = skusQuery.in("produto_id", produtoIdsDaLinha);
      }
      const { data, error: skusErr } = await skusQuery;
      if (skusErr) {
        throw new Error(`falha ao listar SKUs: ${skusErr.message}`);
      }
      skus = data ?? [];
    }

    const rows = (skus ?? []) as unknown as Array<{
      id: string;
      codigo_sku: string;
      atributos: Record<string, unknown> | null;
      produtos: {
        id: string;
        nome: string;
        descricao: string | null;
        produto_linhas: { id: string; nome: string } | { id: string; nome: string }[];
      };
    }>;

    // Diretrizes de cotacao (escopo_id e FK logica, sem FK fisica): carrega a
    // tabela inteira uma vez e indexa por (nivel, escopo_id). Tabela pequena.
    const diretrizesPorEscopo = new Map<string, string[]>();
    const { data: diretrizes, error: diretrizesErr } = await service
      .from("cotacao_diretrizes")
      .select("nivel, escopo_id, texto");
    if (diretrizesErr) {
      throw new Error(`falha ao listar diretrizes: ${diretrizesErr.message}`);
    }
    for (const d of (diretrizes ?? []) as Array<{ nivel: string; escopo_id: string; texto: string }>) {
      const texto = (d.texto ?? "").trim();
      if (!texto) continue;
      const key = `${d.nivel}:${d.escopo_id}`;
      const list = diretrizesPorEscopo.get(key) ?? [];
      list.push(texto);
      diretrizesPorEscopo.set(key, list);
    }

    let indexados = 0;
    let erros = 0;
    let chunks = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Normaliza o join (PostgREST pode retornar objeto ou array).
      const produto = row.produtos;
      const linhaRaw = produto.produto_linhas;
      const linha = Array.isArray(linhaRaw) ? linhaRaw[0] : linhaRaw;
      const linhaNome = linha?.nome ?? "";

      // Diretrizes da LINHA (geral) + PRODUTO + SKU (especifico). Todas somam
      // contexto descritivo ao embedding deste SKU; sem precedencia (nao e
      // decisao). Ordem: geral -> especifico (SKU por ultimo).
      const diretrizesSku = [
        ...(linha?.id ? diretrizesPorEscopo.get(`linha:${linha.id}`) ?? [] : []),
        ...(diretrizesPorEscopo.get(`produto:${produto.id}`) ?? []),
        ...(diretrizesPorEscopo.get(`sku:${row.id}`) ?? []),
      ];

      const skuRow: SkuRow = {
        sku_id: row.id,
        codigo_sku: row.codigo_sku,
        atributos: row.atributos,
        produto_nome: produto.nome,
        produto_descricao: produto.descricao,
        linha_nome: linhaNome,
        diretrizes: diretrizesSku,
      };

      const verbatim = buildVerbatim(skuRow);

      if (!verbatim) {
        // SKU sem dados uteis: pula (nao cria chunk vazio).
        continue;
      }

      try {
        const n = await syncMemoriaChunks(service, {
          origem: CHUNK_ORIGEM,
          tipo: CHUNK_TIPO,
          registroId: row.id,
          verbatim,
          provider,
        });
        chunks += n;
        indexados += 1;
      } catch (err) {
        erros += 1;
        console.error("[produtos-indexar] falha ao indexar SKU", {
          skuId: row.id,
          codigo: row.codigo_sku,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Pausa entre SKUs para aliviar a OpenAI (exceto apos o ultimo).
      if (PAUSA_MS > 0 && i < rows.length - 1) {
        await sleep(PAUSA_MS);
      }
    }

    await logSensitiveAction({
      tabela: "memoria_chunks",
      acao: "backfill_produtos_indexar",
      registroId: null,
      usuario: email,
      dadosNovos: {
        total: rows.length,
        indexados,
        erros,
        chunks,
        escopo: CHUNK_TIPO,
        linha_id: linhaId,
      },
    });

    return jsonResponse(
      { ok: true, total: rows.length, indexados, erros, chunks },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: "produtos-indexar" });
  }
}

getEnv();

Deno.serve(handler);
