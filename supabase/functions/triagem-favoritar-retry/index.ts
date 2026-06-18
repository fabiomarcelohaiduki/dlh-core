// =====================================================================
// Edge Function: triagem-favoritar-retry  (job pg_cron / coleta)
//   -> POST /triagem-favoritar-retry
//
// Duas responsabilidades best-effort/idempotentes, acionadas pelo cron horario
// (disparar_triagem_favoritar_retry -> X-Cron-Secret) e tambem invocavel pela
// coleta (service_role server-side):
//
//   1) RE-TENTATIVA DE FAVORITAR: re-propaga `favoritarLicitacao` para avisos
//      `util` com `favorito_propagado = false` (a API Effecti nao desfavorita,
//      logo re-chamar e seguro). Sucesso => favorito_propagado = true.
//
//   2) DETECCAO DE RESGATE (veto humano): o campo `favorito` de avisos e
//      atualizado pela coleta (mapRawAviso le o payload Effecti). Favorito em
//      aviso `util` = no-op (cai na re-tentativa acima). Favorito em aviso
//      `lixo`/na lixeira sem `favorito_propagado` = VETO HUMANO -> reabilita:
//      remove a lapide (E8: o veto sobrepoe o descarte fisico), re-indexa o
//      verbatim quando disponivel, marca o estado vigente como `util`, registra
//      `feedback_humano = incorreto` na decisao vigente e seta `reabilitado`.
//
// Contrato 3.2.8 (RF-11/27/28/29/30, US-17/18). Autorizacao: chamada interna
// (service_role Bearer OU X-Cron-Secret no Vault). Escrita com service_role.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, matchesCronSecret } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { errorMessage, recordIngestErro } from "../_shared/ingest-errors.ts";
import { EffectiConnector } from "../_shared/effecti-connector.ts";
import { getFonteByTipo, getFonteSecret } from "../_shared/vault.ts";
import {
  createEmbeddingProvider,
  EmbeddingError,
  type EmbeddingProvider,
  generateAndStoreChunks,
} from "../_shared/embeddings.ts";
import { resolveEmbeddingProvider } from "../_shared/indexacao.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "triagem-favoritar-retry";

/** Tetos por execucao (checkpoint do waitUntil do Edge Runtime). */
const MAX_FAVORITAR = 200;
const MAX_RESGATE = 100;

/** Texto-fonte do exemplo de aprendizado (objeto + verbatim) limitado. */
const MAX_TEXTO_CHARS = 2_000;

interface UtilPendenteRow {
  id: string;
  effecti_id: string;
}

interface VetoRow {
  id: string;
  effecti_id: string;
  objeto: string | null;
  conteudo_verbatim: string | null;
  triagem_veredito: string | null;
  na_lixeira: boolean | null;
}

// ---------------------------------------------------------------------
// Autenticacao da chamada interna (service_role OU X-Cron-Secret no Vault).
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

/**
 * Resolve um conector Effecti pronto para write-back de favorito. Best-effort:
 * retorna null quando a fonte/credencial nao esta configurada (o favoritar fica
 * adiado, favorito_propagado permanece false para a proxima execucao).
 */
async function resolveEffectiConnector(): Promise<EffectiConnector | null> {
  try {
    const fonte = await getFonteByTipo("effecti");
    const token = await getFonteSecret(fonte.id);
    if (!token) return null;
    return new EffectiConnector({ endpointBase: fonte.endpointBase, token });
  } catch (err) {
    console.warn(`[triagem-favoritar-retry] conector Effecti indisponivel: ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Gera o embedding (1024-d) do exemplo via MESMO provider do indice
 * (resolveEmbeddingProvider -> OpenAI/Vault) para casar com o vetor do aviso na
 * recuperacao few-shot. Best-effort: null em degradacao.
 */
async function embedExemplo(texto: string): Promise<string | null> {
  let provider: EmbeddingProvider;
  try {
    provider = await resolveEmbeddingProvider();
  } catch (err) {
    console.warn(
      `[triagem-favoritar-retry] provider de embeddings indisponivel; exemplo sem vetor: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  try {
    const [vector] = await provider.embed([texto]);
    if (!Array.isArray(vector) || vector.length === 0) return null;
    return `[${vector.join(",")}]`;
  } catch (err) {
    if (err instanceof EmbeddingError) {
      console.warn(
        `[triagem-favoritar-retry] embeddings indisponiveis; exemplo sem vetor: ${err.message}`,
      );
      return null;
    }
    throw err;
  }
}

/**
 * Re-indexa o verbatim do aviso (chunks + embeddings) de forma best-effort. Sem
 * endpoint de embeddings configurado ou em falha, apenas loga e segue (a
 * reabilitacao nao pode ser derrubada pela indexacao).
 */
async function reindexarBestEffort(
  db: ServiceClient,
  avisoId: string,
  verbatim: string,
): Promise<void> {
  if (verbatim.trim() === "" || !(getEnv().embeddingsEndpoint ?? "").trim()) return;
  try {
    const provider = createEmbeddingProvider();
    await generateAndStoreChunks(db, { avisoId, verbatim, provider });
  } catch (err) {
    console.warn(
      `[triagem-favoritar-retry] reindexacao adiada para aviso ${avisoId}: ${errorMessage(err)}`,
    );
  }
}

// ---------------------------------------------------------------------
// (1) Re-tentativa de favoritar avisos `util` com favorito_propagado=false.
// ---------------------------------------------------------------------

async function reFavoritarUtilPendentes(
  db: ServiceClient,
  connector: EffectiConnector | null,
): Promise<number> {
  const { data, error } = await db
    .from("avisos")
    .select("id, effecti_id")
    .eq("triagem_veredito", "util")
    .eq("favorito_propagado", false)
    .limit(MAX_FAVORITAR);
  if (error) {
    throw new Error(`falha ao listar util pendentes de favoritar: ${error.message}`);
  }
  const pendentes = (data ?? []) as UtilPendenteRow[];
  if (pendentes.length === 0 || !connector) return 0;

  // Mapeia id_licitacao (numero) -> ids de aviso a marcar propagado em sucesso.
  const idsValidos: number[] = [];
  const avisoIdsPorLicitacao = new Map<number, string[]>();
  for (const row of pendentes) {
    const idNum = Number(row.effecti_id);
    if (!Number.isFinite(idNum)) continue;
    idsValidos.push(idNum);
    const lista = avisoIdsPorLicitacao.get(idNum) ?? [];
    lista.push(row.id);
    avisoIdsPorLicitacao.set(idNum, lista);
  }
  if (idsValidos.length === 0) return 0;

  // A API aceita o lote inteiro num PUT; sucesso => marca todos propagados.
  const ok = await connector.favoritarLicitacao(idsValidos);
  if (!ok) {
    for (const row of pendentes) {
      await recordIngestErro(db, {
        avisoId: row.id,
        severidade: "media",
        etapa: "Persistencia",
        mensagem: "re-tentativa de favoritar no Effecti falhou: favorito_propagado=false mantido",
      });
    }
    return 0;
  }

  const avisoIds = pendentes.map((p) => p.id);
  const { error: upErr } = await db
    .from("avisos")
    .update({ favorito: true, favorito_propagado: true })
    .in("id", avisoIds);
  if (upErr) {
    throw new Error(`falha ao marcar favorito_propagado: ${upErr.message}`);
  }
  return avisoIds.length;
}

// ---------------------------------------------------------------------
// (2) Resgate (veto humano): favorito em aviso lixo/na-lixeira sem propagar.
// ---------------------------------------------------------------------

async function reabilitarAviso(
  db: ServiceClient,
  connector: EffectiConnector | null,
  aviso: VetoRow,
): Promise<void> {
  const agora = new Date().toISOString();

  // E8: o veto humano sobrepoe a lapide -> remove para permitir re-coleta.
  const { error: lapideErr } = await db
    .from("triagem_lapide")
    .delete()
    .eq("aviso_id", aviso.id);
  if (lapideErr) {
    throw new Error(`falha ao remover a lapide no resgate: ${lapideErr.message}`);
  }

  // Re-indexa o verbatim disponivel (best-effort).
  await reindexarBestEffort(db, aviso.id, aviso.conteudo_verbatim ?? "");

  // Write-back de favorito (best-effort) antes de gravar o estado vigente.
  let favoritoPropagado = false;
  const idNum = Number(aviso.effecti_id);
  if (connector && Number.isFinite(idNum)) {
    favoritoPropagado = await connector.favoritarLicitacao([idNum]);
  }

  // Estado vigente: entra como `util`, fora da lixeira, reabilitado.
  const { error: avisoErr } = await db
    .from("avisos")
    .update({
      reabilitado: true,
      triagem_veredito: "util",
      triagem_em: agora,
      na_lixeira: false,
      na_lixeira_em: null,
      favorito: true,
      favorito_propagado: favoritoPropagado,
      updated_at: agora,
    })
    .eq("id", aviso.id);
  if (avisoErr) {
    throw new Error(`falha ao reabilitar o aviso: ${avisoErr.message}`);
  }

  // Decisao vigente: registra o feedback humano (nosso lixo estava incorreto).
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
  if (decisaoId) {
    const { error: fbErr } = await db
      .from("triagem_decisoes")
      .update({
        feedback_humano: "incorreto",
        feedback_por: "resgate-effecti",
        feedback_em: agora,
      })
      .eq("id", decisaoId);
    if (fbErr) {
      throw new Error(`falha ao registrar feedback do resgate: ${fbErr.message}`);
    }
  }

  // Exemplo de aprendizado rotulado `util` (idempotente por decisao).
  let exemploId: string | null = null;
  const texto = clip(
    `${aviso.objeto ?? ""}\n${aviso.conteudo_verbatim ?? ""}`.trim(),
    MAX_TEXTO_CHARS,
  );
  if (texto !== "") {
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
        veredito_rotulado: "util",
        embedding,
        ativo: true,
      })
      .select("id")
      .single();
    if (insErr) {
      throw new Error(`falha ao gerar exemplo do resgate: ${insErr.message}`);
    }
    exemploId = (insExemplo as { id: string }).id;
  }

  await logSensitiveAction({
    tabela: "avisos",
    acao: "triagem_resgate",
    registroId: aviso.id,
    usuario: "cron:triagem-favoritar-retry",
    dadosAnteriores: {
      veredito_anterior: aviso.triagem_veredito,
      na_lixeira: aviso.na_lixeira === true,
    },
    dadosNovos: {
      reabilitado: true,
      veredito: "util",
      favorito_propagado: favoritoPropagado,
      feedback_humano: "incorreto",
      exemplo_id: exemploId,
    },
  });
}

async function detectarResgates(
  db: ServiceClient,
  connector: EffectiConnector | null,
): Promise<number> {
  // Veto humano: favorito no Effecti, ainda nao propagado por nos, em aviso que
  // a triagem mandou para lixo OU para a lixeira, e que nao foi reabilitado.
  const { data, error } = await db
    .from("avisos")
    .select("id, effecti_id, objeto, conteudo_verbatim, triagem_veredito, na_lixeira")
    .eq("favorito", true)
    .eq("favorito_propagado", false)
    .eq("reabilitado", false)
    .or("triagem_veredito.eq.lixo,na_lixeira.eq.true")
    .limit(MAX_RESGATE);
  if (error) {
    throw new Error(`falha ao listar resgates pendentes: ${error.message}`);
  }
  const vetos = (data ?? []) as VetoRow[];

  let resgatados = 0;
  for (const aviso of vetos) {
    try {
      await reabilitarAviso(db, connector, aviso);
      resgatados += 1;
    } catch (err) {
      // Falha isolada por aviso NAO interrompe o lote (RNF-11).
      await recordIngestErro(db, {
        avisoId: aviso.id,
        severidade: "media",
        etapa: "Persistencia",
        mensagem: `falha no resgate (reabilitacao): ${errorMessage(err)}`,
      });
      console.error("[triagem-favoritar-retry] falha ao reabilitar aviso", {
        avisoId: aviso.id,
        error: errorMessage(err),
      });
    }
  }
  return resgatados;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    await assertInternalAuth(req);

    const db = createServiceClient();
    const connector = await resolveEffectiConnector();

    const favoritados = await reFavoritarUtilPendentes(db, connector);
    const resgatados = await detectarResgates(db, connector);

    return jsonResponse({ favoritados, resgatados }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
