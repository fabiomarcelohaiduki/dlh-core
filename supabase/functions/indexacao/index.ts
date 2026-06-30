// =====================================================================
// Edge Function: indexacao  ->  /indexacao  (cockpit)
// Painel de controle da INDEXACAO (embeddings) dos documentos. Tres bocas
// numa so funcao (espelha o padrao documentos-descobrir):
//
//   PUT  -> salva a config_indexacao (singleton GLOBAL): master switch
//           `ativo`, allowlist `fontesHabilitadas`, orcamento `loteChunks`,
//           `pausaMs`. Exige sessao autorizada + audit. Vale na PROXIMA
//           invocacao do backfill e no proximo push do continuo.
//
//   POST { action:"registros", ... } -> uma pagina (keyset) da lista mestra
//           consolidada (corpo + anexos por registro) mais as contagens
//           (chips/cards) da guia Indexacao. Read-only (sem audit, sem gasto).
//
//   POST { action:"disparar" } -> aciona 1 lote de backfill AGORA: chama
//           reenfileirar_indexacao() (net.http_post no documentos-indexar,
//           fire-and-forget pelo banco), que se auto-encadeia ate esgotar a
//           fila. Exige sessao autorizada + audit. ACAO QUE GASTA: so tem
//           efeito quando `ativo=true` (o proprio documentos-indexar checa o
//           master switch; OFF => no-op).
//
//   POST { action:"reprocessar_erros", fontes? } -> move os docs em
//           status_indexacao=erro de volta para pendente (RPC
//           reenfileirar_erros_indexacao, filtrado por fonte) e reabre o
//           backfill. Retry idempotente (chunks inseridos atomicamente).
//           Exige sessao autorizada + audit. So gasta quando ativo=true.
//
//   O cockpit NAO chama documentos-indexar direto: aquele Edge so aceita
//   service_role/X-Cron-Secret (chamada interna). Esta funcao e a ponte com
//   sessao de usuario -> service_role.
//
//   A LEITURA da config e hidratada server-side (RLS) na pagina Coleta;
//   nao ha GET aqui (evita superficie sem checagem de allowlist).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  FONTES_EXTRACAO,
  indexacaoConfigSchema,
  parseJsonBody,
} from "../_shared/validation.ts";
import { z } from "zod";

// Defaults de produto da config_indexacao (espelham as migrations). So entram
// no PRIMEIRO insert; com a linha singleton ja seedada, o caminho vivo e o
// update. ativo OFF por default (gasta dinheiro na OpenAI).
const DEFAULTS_INDEXACAO = {
  ativo: false,
  processos_ativo: false,
  fontes_habilitadas: null as string[] | null,
  lote_chunks: 1500,
  pausa_ms: 0,
  tpm_alvo: 800_000,
  tentativas_max: 3,
  embeddings_provider: "openai",
  embeddings_endpoint: null as string | null,
};

// ---------------------------------------------------------------------
// PUT — salva a config_indexacao (singleton) por MERGE PARCIAL. Cada chamador
// (toggle do Agendamento vs drawer de Parametros) manda SO as chaves do seu
// dominio; sobrepomos na linha existente sem zerar o que o outro form possui.
// ---------------------------------------------------------------------
async function handlePut(req: Request): Promise<Response> {
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, indexacaoConfigSchema);

  // Monta o patch SO com as chaves presentes no corpo (snake_case do banco).
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.ativo !== undefined) patch.ativo = input.ativo;
  if (input.processosAtivo !== undefined) patch.processos_ativo = input.processosAtivo;
  if (input.fontesHabilitadas !== undefined) {
    patch.fontes_habilitadas =
      input.fontesHabilitadas && input.fontesHabilitadas.length > 0 ? input.fontesHabilitadas : null;
  }
  if (input.loteChunks !== undefined) patch.lote_chunks = input.loteChunks;
  if (input.pausaMs !== undefined) patch.pausa_ms = input.pausaMs;
  if (input.tpmAlvo !== undefined) patch.tpm_alvo = input.tpmAlvo;
  if (input.tentativasMax !== undefined) patch.tentativas_max = input.tentativasMax;
  if (input.embeddingsProvider !== undefined) {
    patch.embeddings_provider = input.embeddingsProvider;
    // O provider e o endpoint sao do mesmo dono (drawer): openai zera o endpoint
    // (sem URL orfa), bge-m3-local grava a URL informada.
    patch.embeddings_endpoint =
      input.embeddingsProvider === "bge-m3-local" ? input.embeddingsEndpoint ?? null : null;
  }

  const { data: existing, error: selErr } = await db
    .from("config_indexacao")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "indexacao_config_query_failed", "falha ao consultar a config de indexacao");
  }

  if (existing?.id) {
    const { error: updErr } = await db
      .from("config_indexacao")
      .update(patch)
      .eq("id", (existing as { id: string }).id);
    if (updErr) {
      throw new HttpError(500, "indexacao_config_update_failed", "falha ao salvar a config de indexacao");
    }
  } else {
    // Primeiro insert (defensivo — a linha e seedada na migration): defaults de
    // produto sobrepostos pelo patch desta chamada.
    const { error: insErr } = await db
      .from("config_indexacao")
      .insert({ ...DEFAULTS_INDEXACAO, ...patch });
    if (insErr) {
      throw new HttpError(500, "indexacao_config_insert_failed", "falha ao criar a config de indexacao");
    }
  }

  await logSensitiveAction({
    tabela: "config_indexacao",
    acao: "salvar_config_indexacao",
    registroId: existing?.id ?? null,
    usuario: email,
    // Audita SO o que mudou neste patch (sem updated_at).
    dadosNovos: Object.fromEntries(Object.entries(patch).filter(([k]) => k !== "updated_at")),
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// POST { action } — registros (lista+contagens), disparar/reprocessar (backfill).
// ---------------------------------------------------------------------
// Status consolidados da visao vw_indexacao_registros (corpo + anexos por
// registro). Espelham o CASE da migration; usados como filtro da listagem.
const STATUS_CONSOLIDADO = [
  "aguardando_extracao",
  "erro",
  "indexando",
  "pendente",
  "indexado",
  "sem_conteudo",
] as const;

const acaoSchema = z
  .object({
    action: z.enum(["disparar", "reprocessar_erros", "registros", "detalhe"], {
      errorMap: () => ({
        message: "action invalida (use: disparar, reprocessar_erros, registros, detalhe)",
      }),
    }),
    fontes: z
      .array(
        z.enum(FONTES_EXTRACAO, {
          errorMap: () => ({ message: `fonte invalida (use: ${FONTES_EXTRACAO.join(", ")})` }),
        }),
      )
      .transform((items) => Array.from(new Set(items)))
      .nullable()
      .optional(),
    // --- params da action "registros" (listagem paginada por keyset) ---
    fonte: z
      .enum(FONTES_EXTRACAO, {
        errorMap: () => ({ message: `fonte invalida (use: ${FONTES_EXTRACAO.join(", ")})` }),
      })
      .nullable()
      .optional(),
    recurso: z.string().trim().min(1).max(40).nullable().optional(),
    // --- param da action "detalhe" (anexos de UM registro) ---
    registroOrigemId: z.string().trim().min(1).max(200).optional(),
    status: z
      .enum(STATUS_CONSOLIDADO, {
        errorMap: () => ({ message: `status invalido (use: ${STATUS_CONSOLIDADO.join(", ")})` }),
      })
      .nullable()
      .optional(),
    busca: z.string().max(200).nullable().optional(),
    cursor: z
      .object({ c: z.string(), k: z.string() })
      .nullable()
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

// Linha crua devolvida por indexacao_registros_listar (setof da view).
interface RegistroRow {
  id_composto: string;
  fonte: string;
  recurso: string;
  registro_origem_id: string;
  captado_em: string | null;
  status_consolidado: string;
  corpo_status: string | null;
  anexos_indexavel: number | null;
  anexos_indexados: number | null;
  anexos_pendente: number | null;
  anexos_andamento: number | null;
  anexos_erro: number | null;
  anexos_aguardando: number | null;
  titulo_curto: string;
}

interface ContagemRow {
  fonte: string;
  recurso: string | null;
  status: string | null;
  qtd: number | null;
}

// Linha crua de documento_vinculos (anexo) + status do documento extraido.
interface VinculoRow {
  id: string;
  nome_anexo: string | null;
  status_extracao: string | null;
  documento_id: string | null;
}

// Mapeia (extracao do anexo, indexacao do documento) para o MESMO vocabulario
// consolidado da listagem (vw_indexacao_registros), para o front reusar o
// indexacaoConsolidadoDescriptor sem traducao extra.
//   - anexo ainda nao virou texto (pendente/precisa_ocr) -> aguardando_extracao
//   - anexo descartado na extracao (ignorado/inobtenivel) -> sem_conteudo
//   - anexo extraido: o status vem da indexacao do documento
function statusAnexo(statusExtracao: string | null, statusIndexacao: string | null): string {
  if (statusExtracao === "pendente" || statusExtracao === "precisa_ocr") return "aguardando_extracao";
  if (statusExtracao === "ignorado" || statusExtracao === "inobtenivel") return "sem_conteudo";
  // extraido / herdado: olha a indexacao.
  switch (statusIndexacao) {
    case "concluida":
      return "indexado";
    case "em_andamento":
      return "indexando";
    case "erro":
      return "erro";
    default:
      return "pendente";
  }
}

async function handlePost(req: Request): Promise<Response> {
  // Autorizacao primeiro (SEC-02), inclusive para contagem (substrato).
  const { email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, acaoSchema);
  const service = createServiceClient();

  if (input.action === "registros") {
    // Listagem paginada (keyset) da visao consolidada corpo+anexos, espelhando
    // o contrato fila-paginada da extracao. Read-only: sem audit, sem gasto.
    const limit = input.limit ?? 50;
    const cursor = input.cursor ?? null;

    const { data: rowsRaw, error: listErr } = await service.rpc("indexacao_registros_listar", {
      p_fonte: input.fonte ?? null,
      p_recurso: input.recurso ?? null,
      p_status: input.status ?? null,
      p_busca: input.busca ?? null,
      p_cursor_captado_em: cursor?.c ?? null,
      p_cursor_id_composto: cursor?.k ?? null,
      // pede 1 a mais para detectar a proxima pagina sem COUNT.
      p_limit: limit + 1,
    });
    if (listErr) {
      throw new HttpError(500, "indexacao_registros_failed", "falha ao listar os registros de indexacao");
    }
    const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as RegistroRow[];
    const hasMore = rows.length > limit;
    const pagina = hasMore ? rows.slice(0, limit) : rows;

    const itens = pagina.map((r) => ({
      idComposto: r.id_composto,
      fonte: r.fonte,
      recurso: r.recurso,
      registroOrigemId: r.registro_origem_id,
      captadoEm: r.captado_em,
      status: r.status_consolidado,
      corpoStatus: r.corpo_status,
      anexosIndexavel: r.anexos_indexavel ?? 0,
      anexosIndexados: r.anexos_indexados ?? 0,
      anexosPendente: r.anexos_pendente ?? 0,
      anexosAndamento: r.anexos_andamento ?? 0,
      anexosErro: r.anexos_erro ?? 0,
      anexosAguardando: r.anexos_aguardando ?? 0,
      tituloCurto: r.titulo_curto,
    }));

    const ultima = pagina[pagina.length - 1];
    const nextCursor =
      hasMore && ultima ? { c: ultima.captado_em ?? "", k: ultima.id_composto } : null;

    const { data: contRaw, error: contErr } = await service.rpc("indexacao_registros_contagens");
    if (contErr) {
      throw new HttpError(500, "indexacao_contagens_failed", "falha ao apurar as contagens de indexacao");
    }
    const contRows = (Array.isArray(contRaw) ? contRaw : []) as ContagemRow[];
    const porFonte: Record<string, number> = { effecti: 0, nomus: 0, gmail: 0, drive: 0 };
    const porRecurso: Record<string, Record<string, number>> = {};
    const porStatus: Record<string, number> = {
      aguardando_extracao: 0,
      erro: 0,
      indexando: 0,
      pendente: 0,
      indexado: 0,
      sem_conteudo: 0,
    };
    // porFonte×status: alimenta os cards quando ha uma fonte selecionada (os
    // cards passam a refletir o filtro de fonte, nao so o total global).
    const porFonteStatus: Record<string, Record<string, number>> = {};
    let total = 0;
    for (const c of contRows) {
      const n = typeof c.qtd === "number" ? c.qtd : 0;
      total += n;
      if (c.fonte in porFonte) porFonte[c.fonte] += n;
      if (c.status && c.status in porStatus) porStatus[c.status] += n;
      if (c.status) {
        (porFonteStatus[c.fonte] ??= {})[c.status] = (porFonteStatus[c.fonte]?.[c.status] ?? 0) + n;
      }
      // Linhas-zero de fonte vazia vêm com recurso null: nada a aninhar.
      if (c.recurso) {
        (porRecurso[c.fonte] ??= {})[c.recurso] = (porRecurso[c.fonte]?.[c.recurso] ?? 0) + n;
      }
    }

    return jsonResponse({ itens, nextCursor, contagens: { porFonte, porRecurso, porStatus, porFonteStatus, total } }, 200);
  }

  if (input.action === "detalhe") {
    // Anexos de UM registro com o status de indexacao individual (drill-down do
    // X/Y da listagem). Read-only. Exige a identidade do registro.
    if (!input.fonte || !input.registroOrigemId) {
      throw new HttpError(400, "detalhe_identidade_faltando", "informe fonte e registroOrigemId");
    }

    // nomus/pessoas nao tem anexos proprios (a view os deixa zerados para evitar
    // cross-attribution com processos do mesmo nomus_id): nada a abrir.
    if (input.fonte === "nomus" && input.recurso === "pessoas") {
      return jsonResponse({ anexos: [] }, 200);
    }

    const { data: vincRaw, error: vincErr } = await service
      .from("documento_vinculos")
      .select("id, nome_anexo, status_extracao, documento_id")
      .eq("fonte", input.fonte)
      .eq("registro_origem_id", input.registroOrigemId)
      .order("nome_anexo", { ascending: true });
    if (vincErr) {
      throw new HttpError(500, "indexacao_detalhe_failed", "falha ao listar os anexos do registro");
    }
    const vinculos = (Array.isArray(vincRaw) ? vincRaw : []) as VinculoRow[];

    // Status de indexacao dos documentos extraidos (1 fetch IN, sem N+1).
    const docIds = Array.from(
      new Set(vinculos.map((v) => v.documento_id).filter((id): id is string => !!id)),
    );
    const statusPorDoc = new Map<string, string | null>();
    if (docIds.length > 0) {
      const { data: docsRaw, error: docsErr } = await service
        .from("documentos")
        .select("id, status_indexacao")
        .in("id", docIds);
      if (docsErr) {
        throw new HttpError(500, "indexacao_detalhe_docs_failed", "falha ao consultar os documentos do registro");
      }
      for (const d of (docsRaw ?? []) as { id: string; status_indexacao: string | null }[]) {
        statusPorDoc.set(d.id, d.status_indexacao);
      }
    }

    const anexos = vinculos.map((v) => ({
      id: v.id,
      nome: v.nome_anexo,
      status: statusAnexo(
        v.status_extracao,
        v.documento_id ? statusPorDoc.get(v.documento_id) ?? null : null,
      ),
    }));

    return jsonResponse({ anexos }, 200);
  }

  if (input.action === "reprocessar_erros") {
    // Move os docs em status_indexacao=erro de volta para pendente (filtrado
    // por fonte) e reabre o backfill. Retry idempotente (chunks atomicos).
    const fontes = input.fontes && input.fontes.length > 0 ? input.fontes : null;
    const { data, error } = await service.rpc("reenfileirar_erros_indexacao", {
      p_fontes: fontes,
    });
    if (error) {
      throw new HttpError(502, "indexacao_reprocessar_erros_failed", "falha ao reprocessar os erros de indexacao");
    }
    const reenfileirados = typeof data === "number" ? data : 0;

    await logSensitiveAction({
      tabela: "config_indexacao",
      acao: "reprocessar_erros_indexacao",
      registroId: null,
      usuario: email,
      dadosNovos: { fontes, reenfileirados },
    });

    // 202 Accepted: o backfill roda assincrono. Se o master switch estiver
    // OFF, os docs ficam pendentes (sem gasto) ate ligar.
    return jsonResponse({ ok: true, reenfileirados }, 202);
  }

  // action === "disparar": aciona 1 lote de backfill (auto-encadeado).
  const { error } = await service.rpc("reenfileirar_indexacao");
  if (error) {
    throw new HttpError(502, "indexacao_dispatch_failed", "falha ao acionar a indexacao");
  }

  await logSensitiveAction({
    tabela: "config_indexacao",
    acao: "disparar_indexacao",
    registroId: null,
    usuario: email,
    dadosNovos: { acao: "backfill" },
  });

  // 202 Accepted: o backfill roda assincrono (Edge documentos-indexar). Se o
  // master switch estiver OFF, o documentos-indexar responde no-op (nao gasta).
  return jsonResponse({ ok: true }, 202);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    if (req.method === "PUT") return await handlePut(req);
    if (req.method === "POST") return await handlePost(req);
    throw new HttpError(405, "method_not_allowed", "use PUT (config) ou POST (registros/disparar)");
  } catch (err) {
    return await errorResponse(err, { fn: "indexacao" });
  }
}

getEnv();

Deno.serve(handler);
