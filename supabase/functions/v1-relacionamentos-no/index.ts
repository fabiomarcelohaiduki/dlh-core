// =====================================================================
// Edge Function: v1-relacionamentos-no
//   -> POST /v1/relacionamentos/no   (contrato versionado /v1, RNF-17)
//
// MCP read-only da Lia: resolve a METADATA VISUAL de um no da teia de
// Relacionamentos a partir de { tipo, id }. NAO percorre arestas e
// NAO consulta a RPC relacoes_vizinhanca - e a contraparte "atomica"
// (sem vizinhos).
//
// Tabelas-fonte consultadas (uma por `tipo`):
//   aviso     -> public.avisos         (PK uuid, label=objeto|orgao)
//   processo  -> public.nomus_processos (PK uuid, label=nome)
//   pessoa    -> public.nomus_pessoas   (PK uuid, label=nome_razao_social|nome)
//   documento -> public.documentos      (PK uuid, label=nome_arquivo)
//   produto   -> public.produtos        (PK uuid, label=nome)
//   linha     -> public.produto_linhas  (PK uuid, label=nome)
//   sku       -> public.produto_skus    (PK uuid, label=codigo_sku)
//   preco     -> public.sku_precos_calculados (PK uuid, label=regiao/patamar)
//   politica  -> public.politica_participacao (PK uuid, label=participa)
//   cotacao_diretriz -> public.cotacao_diretrizes (PK uuid, label=texto)
//
// Metadata visual (label/icone/cor) e resolvida de um mapa canonico
// fixo (paleta DLH4 do seed 20260630030000_relacionamentos_seed.sql).
// NAO usamos config_tipos_no por org porque a V1 e orgao-agnostica
// (a API key da Lia nao carrega org_id); valores default garantem a
// mesma aparencia independente do chamador, e orgaos especificos que
// precisarem de override podem usar a edge interna /relacionamentos-vizinhanca
// (que ja consulta a tabela por org).
//
// Resolucao on-the-fly com cache TTL 5-10 min chaveado por (tipo, id)
// via _shared/cache.ts:200 - hits entre chamadas dentro da mesma
// instancia da Edge sao imediatos. A chave inclui `principal_label`
// NAO porque a visual e igual para qualquer chamador; em vez disso,
// NAO inclui: o cache e puramente read-through por (tipo, id).
//
// Resposta JSON:
//   { tipo, id, label, icone, cor, estado }
//
// NAO retorna contador_uso/contador_2caminhos - a) o no e atomico,
//    sem grafo, entao a metrica de inferencia nao se aplica; b) o escopo
//    /v1 e read-only por contrato (RNF-01).
//
// Borda padrao:
//   handleCorsPreflight (204 OPTIONS) -> assertMethod POST (405) ->
//   authenticateV1 com requiredScope='read-only:busca-semantica'
//   (a API key da Lia e obrigatoria quando se trata de recurso de
//   servico; sessoes humanas NAO sao aceitas neste endpoint pois a
//   UI do cockpit ja consome diretamente a edge interna configurada
//   por org) -> parseJsonBody zod (422 invalido) -> SELECT na tabela
//   correspondente (404 ausente) -> montagem -> logSensitiveAction
//   (auditoria) -> jsonResponse.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, LIA_SERVICE_SCOPE, principalLabel } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { cacheGetOrSet } from "../_shared/cache.ts";
import {
  parseJsonBody,
  type V1RelacionamentosNoPayload,
  v1RelacionamentosNoPayloadSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "v1-relacionamentos-no";

/** Janela de cache para a resolucao visual do no (entre 5-10 min da SPEC). */
const NO_CACHE_TTL_SECONDS = 600; // 10 min (limite superior)

/** Coluna do tipo "id" aceita por cada tabela-fonte. */
const COL_ID = "id" as const;

// ---------------------------------------------------------------------
// Metadata visual canonica (paleta DLH4 - mesma do seed).
//
// Cada entrada e FIXA: igual para qualquer org. Mudancas nessa paleta
// exigem tambem migracao do seed (20260630030000_relacionamentos_seed.sql).
// Manter sincronizado para garantir consistencia visual entre cockpit
// humano e MCP da Lia.
// ---------------------------------------------------------------------
const DEFAULT_NO_VISUAL = {
  aviso: { label: "Aviso", icone: "file-text", cor: "#e27300" },
  processo: { label: "Processo", icone: "gavel", cor: "#f59e0b" },
  documento: { label: "Documento", icone: "file", cor: "#a1a1aa" },
  pessoa: { label: "Pessoa", icone: "user", cor: "#3b82f6" },
  produto: { label: "Produto", icone: "package", cor: "#10b981" },
  linha: { label: "Linha", icone: "layers", cor: "#8b5cf6" },
  sku: { label: "SKU", icone: "barcode", cor: "#ec4899" },
  preco: { label: "Preço", icone: "badge-dollar-sign", cor: "#22d3ee" },
  politica: { label: "Política", icone: "shield-check", cor: "#84cc16" },
  cotacao_diretriz: { label: "Diretriz", icone: "scroll-text", cor: "#f97316" },
} as const;

/** Resposta serializada do endpoint. */
interface NoVisualV1 {
  tipo: string;
  id: string;
  label: string;
  icone: string;
  cor: string;
  estado: string;
}

type ServiceClient = ReturnType<typeof createServiceClient>;

// ---------------------------------------------------------------------
// Tipo discriminante da linha-fonte retornada pelo SELECT canonico.
//
// Cada caso da uniao traz apenas o `label` (campo textual usado para
// compor a resposta) e o `estado` (campo derivado, normalizado para
// string). Mantemos o tipo simples para evitar acoplar a edge a
// TODAS as colunas das 7 tabelas - usamos `select(campoLabel)` para
// reduzir I/O.
// ---------------------------------------------------------------------
type NoFonteRow =
  | { tipo: "aviso"; label: string; estado: string }
  | { tipo: "processo"; label: string; estado: string }
  | { tipo: "pessoa"; label: string; estado: string }
  | { tipo: "documento"; label: string; estado: string }
  | { tipo: "produto"; label: string; estado: string }
  | { tipo: "linha"; label: string; estado: string }
  | { tipo: "sku"; label: string; estado: string }
  | { tipo: "preco"; label: string; estado: string }
  | { tipo: "politica"; label: string; estado: string }
  | { tipo: "cotacao_diretriz"; label: string; estado: string };

// ---------------------------------------------------------------------
// SELECTs por tabela.
//
// Cada caso seleciona APENAS as colunas usadas para compor a resposta
// (label + estado). Minimiza a transferencia e evita expor dados que
// NAO pertencem a este endpoint (RNF-02). Em caso de null na
// consulta (.maybeSingle), devolvemos 404 na borda.
// ---------------------------------------------------------------------

/** SELECT de public.avisos: label = coalesce(objeto, orgao); estado = status_indexacao. */
async function consultarAviso(db: ServiceClient, id: string): Promise<NoFonteRow | null> {
  const { data, error } = await db
    .from("avisos")
    .select("id, objeto, orgao, status_indexacao")
    .eq(COL_ID, id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "aviso_query_failed", "falha ao consultar aviso");
  }
  if (!data) return null;
  const row = data as {
    objeto: string | null;
    orgao: string | null;
    status_indexacao: string | null;
  };
  const label = row.objeto ?? row.orgao ?? "";
  const estado = row.status_indexacao ?? "desconhecido";
  return { tipo: "aviso", label, estado };
}

/** SELECT de public.nomus_processos: label = nome; estado = status_indexacao. */
async function consultarProcesso(db: ServiceClient, id: string): Promise<NoFonteRow | null> {
  const { data, error } = await db
    .from("nomus_processos")
    .select("id, nome, status_indexacao")
    .eq(COL_ID, id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "processo_query_failed", "falha ao consultar processo");
  }
  if (!data) return null;
  const row = data as { nome: string | null; status_indexacao: string | null };
  return {
    tipo: "processo",
    label: row.nome ?? "",
    estado: row.status_indexacao ?? "desconhecido",
  };
}

/** SELECT de public.nomus_pessoas: label = nome_razao_social OU nome; estado = ativo. */
async function consultarPessoa(db: ServiceClient, id: string): Promise<NoFonteRow | null> {
  const { data, error } = await db
    .from("nomus_pessoas")
    .select("id, nome, nome_razao_social, ativo")
    .eq(COL_ID, id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "pessoa_query_failed", "falha ao consultar pessoa");
  }
  if (!data) return null;
  const row = data as {
    nome: string | null;
    nome_razao_social: string | null;
    ativo: boolean | null;
  };
  const label = row.nome_razao_social ?? row.nome ?? "";
  const estado = row.ativo === false ? "inativo" : "ativo";
  return { tipo: "pessoa", label, estado };
}

/** SELECT de public.documentos: label = nome_arquivo; estado = status_indexacao. */
async function consultarDocumento(db: ServiceClient, id: string): Promise<NoFonteRow | null> {
  const { data, error } = await db
    .from("documentos")
    .select("id, nome_arquivo, status_indexacao")
    .eq(COL_ID, id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "documento_query_failed", "falha ao consultar documento");
  }
  if (!data) return null;
  const row = data as { nome_arquivo: string | null; status_indexacao: string | null };
  return {
    tipo: "documento",
    label: row.nome_arquivo ?? "",
    estado: row.status_indexacao ?? "desconhecido",
  };
}

/** SELECT de public.produtos: label = nome; estado = ativo. */
async function consultarProduto(db: ServiceClient, id: string): Promise<NoFonteRow | null> {
  const { data, error } = await db
    .from("produtos")
    .select("id, nome, ativo")
    .eq(COL_ID, id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "produto_query_failed", "falha ao consultar produto");
  }
  if (!data) return null;
  const row = data as { nome: string | null; ativo: boolean | null };
  const estado = row.ativo === false ? "inativo" : "ativo";
  return { tipo: "produto", label: row.nome ?? "", estado };
}

/** SELECT de public.produto_linhas: label = nome; estado = ativo. */
async function consultarLinha(db: ServiceClient, id: string): Promise<NoFonteRow | null> {
  const { data, error } = await db
    .from("produto_linhas")
    .select("id, nome, ativo")
    .eq(COL_ID, id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "linha_query_failed", "falha ao consultar linha");
  }
  if (!data) return null;
  const row = data as { nome: string | null; ativo: boolean | null };
  const estado = row.ativo === false ? "inativo" : "ativo";
  return { tipo: "linha", label: row.nome ?? "", estado };
}

/** SELECT de public.produto_skus: label = codigo_sku; estado = ativo/inativo. */
async function consultarSku(db: ServiceClient, id: string): Promise<NoFonteRow | null> {
  const { data, error } = await db
    .from("produto_skus")
    .select("id, codigo_sku, ativo")
    .eq(COL_ID, id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "sku_query_failed", "falha ao consultar sku");
  }
  if (!data) return null;
  const row = data as { codigo_sku: string | null; ativo: boolean | null };
  return {
    tipo: "sku",
    label: row.codigo_sku ?? "",
    estado: row.ativo === false ? "inativo" : "ativo",
  };
}

/** SELECT de public.sku_precos_calculados: label = regiao/patamar; estado = estado. */
async function consultarPreco(db: ServiceClient, id: string): Promise<NoFonteRow | null> {
  const { data, error } = await db
    .from("sku_precos_calculados")
    .select("id, regiao, patamar, estado")
    .eq(COL_ID, id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "preco_query_failed", "falha ao consultar preco");
  }
  if (!data) return null;
  const row = data as { regiao: string | null; patamar: string | null; estado: string | null };
  const label = [row.regiao, row.patamar].filter(Boolean).join(" / ");
  return { tipo: "preco", label, estado: row.estado ?? "desconhecido" };
}

/** SELECT de public.politica_participacao: label = participa; estado = nivel. */
async function consultarPolitica(db: ServiceClient, id: string): Promise<NoFonteRow | null> {
  const { data, error } = await db
    .from("politica_participacao")
    .select("id, nivel, participa")
    .eq(COL_ID, id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "politica_query_failed", "falha ao consultar politica");
  }
  if (!data) return null;
  const row = data as { nivel: string | null; participa: string | null };
  return {
    tipo: "politica",
    label: row.participa ? `Participa: ${row.participa}` : "Política",
    estado: row.nivel ?? "desconhecido",
  };
}

/** SELECT de public.cotacao_diretrizes: label = texto resumido; estado = nivel. */
async function consultarCotacaoDiretriz(
  db: ServiceClient,
  id: string,
): Promise<NoFonteRow | null> {
  const { data, error } = await db
    .from("cotacao_diretrizes")
    .select("id, nivel, texto")
    .eq(COL_ID, id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "diretriz_query_failed", "falha ao consultar diretriz");
  }
  if (!data) return null;
  const row = data as { nivel: string | null; texto: string | null };
  const label = row.texto?.trim().slice(0, 120) ?? "Diretriz";
  return { tipo: "cotacao_diretriz", label, estado: row.nivel ?? "desconhecido" };
}

/** Dispatcher: roteia para a tabela-fonte do tipo. */
async function consultarNo(
  db: ServiceClient,
  tipo: V1RelacionamentosNoPayload["tipo"],
  id: string,
): Promise<NoFonteRow | null> {
  switch (tipo) {
    case "aviso":
      return await consultarAviso(db, id);
    case "processo":
      return await consultarProcesso(db, id);
    case "pessoa":
      return await consultarPessoa(db, id);
    case "documento":
      return await consultarDocumento(db, id);
    case "produto":
      return await consultarProduto(db, id);
    case "linha":
      return await consultarLinha(db, id);
    case "sku":
      return await consultarSku(db, id);
    case "preco":
      return await consultarPreco(db, id);
    case "politica":
      return await consultarPolitica(db, id);
    case "cotacao_diretriz":
      return await consultarCotacaoDiretriz(db, id);
    default:
      // Defesa: tipo validado pelo zod; nunca deve cair aqui.
      throw new HttpError(500, "tipo_invalido_interno", `tipo nao roteado: ${String(tipo)}`);
  }
}

// ---------------------------------------------------------------------
// Cache key: (tipo, id). Chave estavel entre chamadas.
// ---------------------------------------------------------------------
function chaveNo(tipo: string, id: string): string {
  return `${tipo}:${id}`;
}

// ---------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao na borda: somente a API key de servico read-only
    // (LIA_SERVICE_SCOPE) OU sessoes humanas autorizadas. A spec
    // permite ambas, mas a UI do cockpit ja consome a edge interna
    // configurada por org - esta V1 existe para a Lia consumir.
    const principal = await authenticateV1(req, {
      requiredScope: LIA_SERVICE_SCOPE,
    });

    // Validacao server-side (zod): tipo na enum canonica; id string
    // nao-vazia. 422 para payload invalido (escolha consistente com
    // os outros endpoints V1 parametrizados por enum).
    const payload = await parseJsonBody(req, v1RelacionamentosNoPayloadSchema, {
      validationStatus: 422,
    });

    const db = createServiceClient();

    // Cache + select. A chave NAO depende de principal_label (a
    // visual e igual para qualquer chamador); principal_label so
    // aparece na auditoria.
    const resposta = await cacheGetOrSet<NoVisualV1>(
      "v1-relacionamentos.no",
      chaveNo(payload.tipo, payload.id),
      async () => {
        const fonte = await consultarNo(db, payload.tipo, payload.id);
        if (!fonte) {
          // 404 explicito: ausencia do registro na tabela-fonte
          // NAO e cacheada (a proxima chamada re-tenta direto). Mas
          // como cacheGetOrSet cachearia a excecao se lancada, usamos
          // um payload sentinela com label vazio + estado=null para
          // sinalizar "nao existe" sem lancar. Aqui preferimos nao
          // cachear 404 - relancamos fora do fetcher.
          throw new HttpError(
            404,
            "no_nao_encontrado",
            `no (${payload.tipo}, ${payload.id}) nao encontrado`,
          );
        }
        const visual = DEFAULT_NO_VISUAL[fonte.tipo];
        return {
          tipo: fonte.tipo,
          id: payload.id,
          label: fonte.label,
          icone: visual.icone,
          cor: visual.cor,
          estado: fonte.estado,
        };
      },
      NO_CACHE_TTL_SECONDS,
    );

    // Auditoria: registra a consulta read-only (RNF-08). NUNCA
    // expoe o conteudo de payload completo (apenas tipo+id).
    await logSensitiveAction({
      tabela: "v1-relacionamentos-no",
      acao: "read",
      registroId: payload.id,
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        scope: principal.kind === "service" ? principal.scope : "human",
        tipo: payload.tipo,
        id: payload.id,
        label: resposta.label,
        estado: resposta.estado,
      },
    });

    return jsonResponse(resposta, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
