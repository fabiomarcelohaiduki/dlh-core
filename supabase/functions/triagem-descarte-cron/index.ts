// =====================================================================
// Edge Function: triagem-descarte-cron  (job pg_cron - descarte fisico)
//   -> POST /triagem-descarte-cron
//
// Job diario (03:00 UTC, baixa carga) acionado pelo pg_cron
// (disparar_triagem_descarte -> X-Cron-Secret). Processa em LOTE com
// checkpoint (ate 200 avisos/execucao) para nao estourar o waitUntil do Edge
// Runtime. So age sobre avisos `na_lixeira = true` ha mais de `dias_carencia`
// E `reabilitado = false` E somente quando `descarte_fisico_ligado = true`.
//
// Ao descartar: NULA o peso (conteudo_verbatim, texto_extraido dos anexos em
// aviso_arquivos, chunks/embedding em aviso_chunks), grava a LAPIDE
// anti-recoleta (triagem_lapide: conteudo_hash, id_licitacao, veredito_final),
// gera um exemplo de aprendizado rotulado e audita com snapshot anterior.
//
// Em MODO SOMBRA (descarte_fisico_ligado = false) NAO apaga nada e retorna
// { descartados: 0, modo_sombra: true }.
//
// Idempotencia: o filtro exclui avisos cujo peso ja foi nulado
// (conteudo_verbatim <> ''), de modo que re-rodar nunca reprocessa nem trava a
// fila. Contrato 3.2.7 (RF-24/25, US-16, SEC-2, E13).
//
// Autorizacao: chamada interna (service_role Bearer OU X-Cron-Secret no Vault).
// NENHUMA credencial /v1 pode dispara-lo. Escrita com service_role (RNF-02).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, matchesCronSecret } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { errorMessage, recordIngestErro } from "../_shared/ingest-errors.ts";
import { createEmbeddingProvider, EmbeddingError } from "../_shared/embeddings.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "triagem-descarte-cron";

/** Teto de avisos descartados por execucao (checkpoint do waitUntil, E13). */
const MAX_POR_EXECUCAO = 200;

/** Texto-fonte do exemplo de aprendizado (objeto + verbatim) limitado. */
const MAX_TEXTO_CHARS = 2_000;

const MS_PER_DAY = 86_400_000;

interface AvisoRow {
  id: string;
  effecti_id: string;
  objeto: string | null;
  conteudo_verbatim: string | null;
  conteudo_hash: string | null;
  triagem_veredito: string | null;
  na_lixeira_em: string | null;
}

// ---------------------------------------------------------------------
// Autenticacao da chamada interna (service_role OU X-Cron-Secret no Vault).
// Nenhuma credencial /v1 (LIA/TRIAGEM) e service_role => nunca dispara o cron.
// ---------------------------------------------------------------------

async function assertInternalAuth(req: Request): Promise<void> {
  const bearer = extractBearerToken(req);
  const env = getEnv();
  if (bearer && timingSafeEqual(bearer, env.serviceRoleKey)) return;
  if (await matchesCronSecret(req)) return;
  throw new HttpError(401, "cron_unauthorized", "chamada interna nao autorizada");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Le dias_carencia + descarte_fisico_ligado da config singleton. */
async function loadConfig(
  db: ServiceClient,
): Promise<{ diasCarencia: number; descarteFisicoLigado: boolean }> {
  const { data, error } = await db
    .from("config_automacao")
    .select("dias_carencia, descarte_fisico_ligado")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler config_automacao: ${error.message}`);
  }
  const dias = Number(data?.dias_carencia);
  return {
    diasCarencia: Number.isFinite(dias) && dias >= 1 ? Math.trunc(dias) : 30,
    descarteFisicoLigado: data?.descarte_fisico_ligado === true,
  };
}

/**
 * Gera o embedding (1024-d) do texto do exemplo reusando o provider plugavel.
 * Best-effort: em degradacao (provider ausente/indisponivel) retorna null e o
 * exemplo e gravado sem vetor, sem derrubar o descarte.
 */
async function embedExemplo(texto: string): Promise<string | null> {
  if (!(getEnv().embeddingsEndpoint ?? "").trim()) return null;
  try {
    const provider = createEmbeddingProvider();
    const [vector] = await provider.embed([texto]);
    if (!Array.isArray(vector) || vector.length === 0) return null;
    return `[${vector.join(",")}]`;
  } catch (err) {
    if (err instanceof EmbeddingError) {
      console.warn(
        `[triagem-descarte-cron] embeddings indisponiveis; exemplo sem vetor: ${err.message}`,
      );
      return null;
    }
    throw err;
  }
}

/**
 * Descarta FISICAMENTE um aviso elegivel: nula o peso, grava a lapide, gera o
 * exemplo de aprendizado e audita. Cada aviso e isolado pelo chamador (falha de
 * um nao derruba o lote). Retorna true quando o descarte foi efetivado.
 */
async function descartarAviso(db: ServiceClient, aviso: AvisoRow): Promise<boolean> {
  const agora = new Date().toISOString();

  // 0) Captura o texto-fonte do exemplo ANTES de nular o verbatim.
  const texto = clip(
    `${aviso.objeto ?? ""}\n${aviso.conteudo_verbatim ?? ""}`.trim(),
    MAX_TEXTO_CHARS,
  );

  // 1) Decisao vigente (ultima do aviso) para vincular o exemplo (pode faltar).
  const { data: decisaoRaw, error: decErr } = await db
    .from("triagem_decisoes")
    .select("id")
    .eq("aviso_id", aviso.id)
    .order("decidido_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (decErr) {
    throw new Error(`falha ao consultar a decisao vigente: ${decErr.message}`);
  }
  const decisaoId = (decisaoRaw as { id: string } | null)?.id ?? null;

  // 2) Conta os chunks antes de remove-los (para o snapshot de auditoria).
  const { count: chunksCount } = await db
    .from("aviso_chunks")
    .select("id", { count: "exact", head: true })
    .eq("aviso_id", aviso.id);

  // 3) Remove os chunks/embeddings (peso de busca).
  const { error: chunksErr } = await db
    .from("aviso_chunks")
    .delete()
    .eq("aviso_id", aviso.id);
  if (chunksErr) {
    throw new Error(`falha ao remover chunks: ${chunksErr.message}`);
  }

  // 4) Nula o texto extraido dos anexos (o binario fica no Storage; aqui some
  //    o conteudo pesado indexavel).
  const { error: anexosErr } = await db
    .from("aviso_arquivos")
    .update({ texto_extraido: null })
    .eq("aviso_id", aviso.id);
  if (anexosErr) {
    throw new Error(`falha ao nular anexos: ${anexosErr.message}`);
  }

  // 5) Nula o verbatim do aviso. conteudo_verbatim e NOT NULL no schema -> usa
  //    string vazia, que tambem e o marcador de idempotencia (filtro neq '').
  const { error: avisoErr } = await db
    .from("avisos")
    .update({ conteudo_verbatim: "", updated_at: agora })
    .eq("id", aviso.id);
  if (avisoErr) {
    throw new Error(`falha ao nular o verbatim do aviso: ${avisoErr.message}`);
  }

  // 6) Lapide anti-recoleta (idempotente por aviso_id).
  const idLicitacao = Number(aviso.effecti_id);
  const { error: lapideErr } = await db
    .from("triagem_lapide")
    .upsert({
      aviso_id: aviso.id,
      conteudo_hash: aviso.conteudo_hash,
      id_licitacao: Number.isFinite(idLicitacao) ? idLicitacao : null,
      veredito_final: aviso.triagem_veredito,
      descartado_em: agora,
    }, { onConflict: "aviso_id" });
  if (lapideErr) {
    throw new Error(`falha ao gravar a lapide: ${lapideErr.message}`);
  }

  // 7) Exemplo de aprendizado rotulado (idempotente por decisao quando houver).
  let exemploId: string | null = null;
  if (texto !== "" && aviso.triagem_veredito != null) {
    if (decisaoId) {
      const { error: delExErr } = await db
        .from("triagem_exemplos")
        .delete()
        .eq("decisao_id", decisaoId);
      if (delExErr) {
        throw new Error(`falha ao limpar exemplo anterior: ${delExErr.message}`);
      }
    }
    const embedding = await embedExemplo(texto);
    const { data: insExemplo, error: insErr } = await db
      .from("triagem_exemplos")
      .insert({
        aviso_id: aviso.id,
        decisao_id: decisaoId,
        texto,
        veredito_rotulado: aviso.triagem_veredito,
        embedding,
        ativo: true,
      })
      .select("id")
      .single();
    if (insErr) {
      throw new Error(`falha ao gerar exemplo rotulado: ${insErr.message}`);
    }
    exemploId = (insExemplo as { id: string }).id;
  }

  // 8) Auditoria com snapshot anterior (sem conteudo sensivel: apenas metadados).
  await logSensitiveAction({
    tabela: "avisos",
    acao: "triagem_descarte_fisico",
    registroId: aviso.id,
    usuario: "cron:triagem-descarte",
    dadosAnteriores: {
      veredito_final: aviso.triagem_veredito,
      na_lixeira_em: aviso.na_lixeira_em,
      tinha_verbatim: (aviso.conteudo_verbatim ?? "") !== "",
      chunks_removidos: chunksCount ?? null,
    },
    dadosNovos: {
      descartado: true,
      exemplo_id: exemploId,
    },
  });

  return true;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    await assertInternalAuth(req);

    const db = createServiceClient();
    const { diasCarencia, descarteFisicoLigado } = await loadConfig(db);

    // Modo sombra: NAO apaga nada (gate do recall antes do descarte fisico).
    if (!descarteFisicoLigado) {
      return jsonResponse({ descartados: 0, modo_sombra: true }, 200);
    }

    // Carencia expirada: na_lixeira_em <= agora - dias_carencia.
    const cutoff = new Date(Date.now() - diasCarencia * MS_PER_DAY).toISOString();

    // Elegiveis: na lixeira, nao reabilitados, carencia vencida e ainda COM
    // peso (conteudo_verbatim <> '' garante idempotencia e progresso da fila).
    const { data: candidatosRaw, error: selErr } = await db
      .from("avisos")
      .select(
        "id, effecti_id, objeto, conteudo_verbatim, conteudo_hash, triagem_veredito, na_lixeira_em",
      )
      .eq("na_lixeira", true)
      .eq("reabilitado", false)
      .neq("conteudo_verbatim", "")
      .lte("na_lixeira_em", cutoff)
      .order("na_lixeira_em", { ascending: true })
      .limit(MAX_POR_EXECUCAO);
    if (selErr) {
      throw new Error(`falha ao listar avisos elegiveis ao descarte: ${selErr.message}`);
    }
    const candidatos = (candidatosRaw ?? []) as AvisoRow[];

    let descartados = 0;
    for (const aviso of candidatos) {
      try {
        if (await descartarAviso(db, aviso)) descartados += 1;
      } catch (err) {
        // Falha isolada por aviso NAO interrompe o lote (RNF-11).
        await recordIngestErro(db, {
          avisoId: aviso.id,
          severidade: "media",
          etapa: "Persistencia",
          mensagem: `falha no descarte fisico: ${errorMessage(err)}`,
        });
        console.error("[triagem-descarte-cron] falha ao descartar aviso", {
          avisoId: aviso.id,
          error: errorMessage(err),
        });
      }
    }

    return jsonResponse({ descartados, modo_sombra: false }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
