// =====================================================================
// Edge Function: v1-triagem-veredito  (Caminho 2 - escrita do veredito cru)
//   -> POST /v1-triagem-veredito
//
// Recebe o veredito CRU do Lion (rotulo alta/media/baixa + motivo +
// produto_candidato). O servidor traduz o rotulo na confianca canonica
// (rotuloParaConfianca, deterministico) e classifica server-side (3.2.2 / 3.4):
// aplica as regras duras
// deterministicas (E5), os limiares do `config_automacao` (fonte unica de
// verdade) e a invariante "util tem produto" (E12), grava o historico
// (`triagem_decisoes`) e o estado vigente (`avisos`), favorita no Effecti os
// `util` (best-effort) e marca a lixeira soft nos `lixo`.
//
// Autorizacao na borda (RNF-01 / SEC-1): authenticateV1 com requiredScope
// `write:triagem` autoriza ANTES do corpo. Sem credencial -> 401; credencial
// sem o escopo (ex.: read-only da Lia) ou sessao humana -> 403. Toda a escrita
// roda com service_role (RNF-07).
//
// Codigos: 200 ok; 400 body invalido (zod); 401 sem credencial; 403 escopo
// invalido; 404 aviso inexistente; 409 aviso ja triado para o conteudo vigente
// (rede de seguranca anti-duplicidade: uma rodada = um veredito por versao de
// conteudo; a re-triagem so ocorre quando o `conteudo_hash` muda e o pipeline
// zera `triagem_veredito`, reabilitando o aviso na FILA).
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, principalLabel, TRIAGEM_WRITE_SCOPE } from "../_shared/service-auth.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { errorMessage, recordIngestErro } from "../_shared/ingest-errors.ts";
import { EffectiConnector } from "../_shared/effecti-connector.ts";
import { getFonteByTipo, getFonteSecret } from "../_shared/vault.ts";
import {
  avaliarRegras,
  classificar,
  type LimiaresConfig,
  produzirEstadoVigente,
  type RegrasDuras,
  rotuloParaConfianca,
} from "../_shared/triagem-ingestao.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "v1-triagem-veredito";

// ---------------------------------------------------------------------
// Validacao do corpo (zod). Body invalido -> 400 (parseJsonBody).
// ---------------------------------------------------------------------

const produtoCandidatoSchema = z.object({
  produto_id: z.string().uuid("produto_id deve ser um uuid valido").nullable(),
  nome: z.string().max(500).nullable(),
  // Opcional: quando o subagente chegou ao SKU especifico, habilita a
  // precedencia SKU no gate de politica (sku > produto > linha). Ausente ->
  // o gate resolve a politica no nivel produto/linha.
  sku_id: z.string().uuid("sku_id deve ser um uuid valido").nullish(),
});

const veredictoBodySchema = z.object({
  aviso_id: z.string().uuid("aviso_id deve ser um uuid valido"),
  rotulo: z.enum(["alta", "media", "baixa"], {
    errorMap: () => ({ message: "rotulo deve ser 'alta', 'media' ou 'baixa'" }),
  }),
  motivo: z.string().max(5_000).nullish(),
  produto_candidato: produtoCandidatoSchema.nullish(),
  agente_versao: z.number().int("agente_versao deve ser inteiro").nullish(),
});

type VeredictoBody = z.infer<typeof veredictoBodySchema>;

// ---------------------------------------------------------------------
// Tipos internos das linhas lidas.
// ---------------------------------------------------------------------

interface AvisoRow {
  id: string;
  effecti_id: string;
  objeto: string | null;
  conteudo_verbatim: string | null;
  triagem_veredito: string | null;
  reabilitado: boolean | null;
}

// Estados de extracao de TEXTO (documento_vinculos.status_extracao) com texto
// aproveitavel para extrair itens — espelha STATUS_EXTRACAO_COM_TEXTO da fila.
// So docs com texto entram no gate: docs sem texto nunca poderao ter itens
// estruturados e bloquear lixo neles seria eterno.
const STATUS_EXTRACAO_COM_TEXTO = ["extraido", "herdado", "precisa_ocr"];

// itens_status NAO-terminais: a lista de itens ainda nao foi estruturada (ou
// falhou e e reprocessavel). 'extraido'/'sem_itens'/'ignorado'/'inobtenivel'
// sao terminais (a extracao foi conclusivamente resolvida).
const ITENS_STATUS_NAO_TERMINAL = ["pendente", "erro"];

// ---------------------------------------------------------------------
// Leitura de insumos de classificacao (config + regras), via service_role.
// ---------------------------------------------------------------------

async function loadLimiares(db: ServiceClient): Promise<LimiaresConfig> {
  const { data, error } = await db
    .from("config_automacao")
    .select("limiar_inferior, limiar_superior")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler config_automacao: ${error.message}`);
  }
  // Numeric pode chegar como string pelo PostgREST: coage com fallback ao seed.
  const inferior = Number(data?.limiar_inferior);
  const superior = Number(data?.limiar_superior);
  return {
    limiar_inferior: Number.isFinite(inferior) ? inferior : 0.35,
    limiar_superior: Number.isFinite(superior) ? superior : 0.55,
  };
}

async function loadRegrasDuras(db: ServiceClient): Promise<RegrasDuras> {
  const { data, error } = await db
    .from("triagem_regras")
    .select("tipo, termo")
    .eq("ativo", true);
  if (error) {
    throw new Error(`falha ao ler triagem_regras: ${error.message}`);
  }
  const foraDeRamo: string[] = [];
  const termoProduto: string[] = [];
  for (const row of (data ?? []) as { tipo: string; termo: string }[]) {
    if (row.tipo === "fora_de_ramo") foraDeRamo.push(row.termo);
    else if (row.tipo === "termo_produto") termoProduto.push(row.termo);
  }
  return { fora_de_ramo: foraDeRamo, termo_produto: termoProduto };
}

// ---------------------------------------------------------------------
// Efeito best-effort: favoritar a licitacao no Effecti (veredito `util`).
// Idempotente (a API nao desfavorita) e NUNCA derruba a resposta: qualquer
// falha (credencial ausente, id invalido, erro do Effecti) e registrada em
// erros_ingestao e retorna false -> `favorito_propagado` fica false para retry
// (proxima coleta / cron de re-tentativa reprocessa). SEC-09: o erro nunca
// carrega conteudo sensivel, apenas o id do aviso afetado.
// ---------------------------------------------------------------------

async function favoritarEffectiBestEffort(db: ServiceClient, aviso: AvisoRow): Promise<boolean> {
  const idNum = Number(aviso.effecti_id);
  if (!Number.isFinite(idNum)) {
    await recordIngestErro(db, {
      avisoId: aviso.id,
      severidade: "media",
      etapa: "Persistencia",
      mensagem:
        "veredito util sem effecti_id valido: favoritar adiado (favorito_propagado=false)",
    });
    return false;
  }

  try {
    const fonte = await getFonteByTipo("effecti");
    const token = await getFonteSecret(fonte.id);
    if (!token) {
      await recordIngestErro(db, {
        avisoId: aviso.id,
        severidade: "media",
        etapa: "Persistencia",
        mensagem: "credencial Effecti nao configurada: favoritar adiado (favorito_propagado=false)",
      });
      return false;
    }

    const connector = new EffectiConnector({ endpointBase: fonte.endpointBase, token });
    const ok = await connector.favoritarLicitacao([idNum]);
    if (!ok) {
      await recordIngestErro(db, {
        avisoId: aviso.id,
        severidade: "media",
        etapa: "Persistencia",
        mensagem: "falha ao favoritar licitacao no Effecti: favorito_propagado=false para retry",
      });
    }
    return ok;
  } catch (err) {
    await recordIngestErro(db, {
      avisoId: aviso.id,
      severidade: "media",
      etapa: "Persistencia",
      mensagem: `erro ao favoritar no Effecti: ${errorMessage(err)}`,
    });
    return false;
  }
}

// ---------------------------------------------------------------------
// Gate de RECALL (deterministico, SOM): um aviso NUNCA pode ser classificado
// `lixo` enquanto houver documento EXTRAIVEL (status_extracao com texto) cuja
// lista de itens ainda nao foi estruturada (itens_status pendente/erro). Sem
// ler a lista, a decisao de descarte e cega — risco de perder uma licitacao
// com produto DLH escondido num edital de objeto fora do ramo (provado em
// producao: edital de "artesanato" com item de tecido alvejado em rolo). Quando
// o gate dispara, o lixo e rebaixado a `duvida` (validacao humana / re-extracao).
// Espelha o filtro da FILA (status_extracao com texto): docs sem texto nunca
// poderao ter itens e por isso nao bloqueiam (descarte permanece possivel).
// ---------------------------------------------------------------------

async function temDocExtraivelSemItens(db: ServiceClient, effectiId: string): Promise<boolean> {
  const eid = (effectiId ?? "").trim();
  if (eid === "") return false;

  // 1) Documentos vinculados ao aviso (por effecti_id) com texto aproveitavel.
  const { data: vinculos, error: vincErr } = await db
    .from("documento_vinculos")
    .select("documento_id")
    .eq("fonte", "effecti")
    .eq("registro_origem_id", eid)
    .in("status_extracao", STATUS_EXTRACAO_COM_TEXTO);
  if (vincErr) {
    throw new Error(`falha ao ler documento_vinculos (gate de recall): ${vincErr.message}`);
  }
  const docIds = [...new Set((vinculos ?? []).map((v) => v.documento_id as string).filter(Boolean))];
  if (docIds.length === 0) return false;

  // 2) Algum desses docs com a lista de itens ainda nao estruturada?
  const { data: pendentes, error: docErr } = await db
    .from("documentos")
    .select("id")
    .in("id", docIds)
    .in("itens_status", ITENS_STATUS_NAO_TERMINAL)
    .limit(1);
  if (docErr) {
    throw new Error(`falha ao ler documentos (gate de recall): ${docErr.message}`);
  }
  return (pendentes ?? []).length > 0;
}

// ---------------------------------------------------------------------
// Gate de POLITICA (deterministico, SOM): um aviso NUNCA pode virar `util`
// (favoritar + bid) quando o produto candidato casado tem politica de
// participacao `nao`. A IA IDENTIFICA o produto (probabilistico); a regra de
// participar/nao-participar e DETERMINISTICA (vem do banco). O metodo do
// cockpit ja instrui o subagente a nao usar produto `nao` como candidato, mas
// esta e a rede de seguranca server-side (simetrica ao gate de recall): se o
// candidato escapar com `nao`, o `util` e rebaixado a `duvida` (validacao
// humana). `sim` / `condicional` (depende de criterio que a IA avaliou) / sem
// politica cadastrada NAO bloqueiam. Precedencia de resolucao: sku > produto >
// linha (espelha v1-politica-participacao). So consulta o banco quando relevante.
// ---------------------------------------------------------------------

async function candidatoNaoParticipa(
  db: ServiceClient,
  produtoId: string,
  skuId: string | null,
): Promise<boolean> {
  // Resolve a linha do produto (nivel LINHA da precedencia).
  const { data: prod, error: prodErr } = await db
    .from("produtos")
    .select("linha_id")
    .eq("id", produtoId)
    .maybeSingle();
  if (prodErr) {
    throw new Error(`falha ao ler produto (gate de politica): ${prodErr.message}`);
  }
  const linhaId = (prod?.linha_id as string | null) ?? null;

  // Politicas que cobrem este candidato (sku/produto/linha). Tabela pequena;
  // filtramos pelos escopos relevantes e aplicamos a precedencia em memoria.
  const escoposProduto = [produtoId];
  const escoposLinha = linhaId ? [linhaId] : [];
  const escoposSku = skuId ? [skuId] : [];

  const { data: rows, error: polErr } = await db
    .from("politica_participacao")
    .select("nivel, escopo_id, participa")
    .or(
      [
        `and(nivel.eq.produto,escopo_id.in.(${escoposProduto.join(",")}))`,
        escoposSku.length ? `and(nivel.eq.sku,escopo_id.in.(${escoposSku.join(",")}))` : null,
        escoposLinha.length ? `and(nivel.eq.linha,escopo_id.in.(${escoposLinha.join(",")}))` : null,
      ]
        .filter(Boolean)
        .join(","),
    );
  if (polErr) {
    throw new Error(`falha ao ler politica_participacao (gate de politica): ${polErr.message}`);
  }

  const porChave = new Map<string, string>();
  for (const r of (rows ?? []) as { nivel: string; escopo_id: string; participa: string }[]) {
    const key = `${r.nivel}:${r.escopo_id}`;
    if (!porChave.has(key)) porChave.set(key, r.participa);
  }

  // Precedencia sku > produto > linha (a primeira politica encontrada vence).
  const participa = (skuId ? porChave.get(`sku:${skuId}`) : undefined) ??
    porChave.get(`produto:${produtoId}`) ??
    (linhaId ? porChave.get(`linha:${linhaId}`) : undefined) ??
    null;

  return participa === "nao";
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao na borda: recurso EXCLUSIVO de servico de ESCRITA.
    // Sem credencial -> 401; escopo != write:triagem -> 403. Antes do corpo.
    const principal = await authenticateV1(req, { requiredScope: TRIAGEM_WRITE_SCOPE });

    const body: VeredictoBody = await parseJsonBody(req, veredictoBodySchema);
    const db = createServiceClient();

    // 1) Carrega o aviso (404 quando inexistente).
    const { data: avisoRaw, error: avisoErr } = await db
      .from("avisos")
      .select("id, effecti_id, objeto, conteudo_verbatim, triagem_veredito, reabilitado")
      .eq("id", body.aviso_id)
      .maybeSingle();
    if (avisoErr) {
      throw new Error(`falha ao consultar o aviso: ${avisoErr.message}`);
    }
    if (!avisoRaw) {
      throw new HttpError(404, "aviso_nao_encontrado", "aviso inexistente");
    }
    const aviso = avisoRaw as AvisoRow;

    // 2) Rede de seguranca anti-duplicidade: aviso ja triado para o conteudo
    //    vigente. `triagem_veredito` so volta a NULL quando o `conteudo_hash`
    //    muda (re-coleta/re-indexacao), reabilitando-o na FILA -> nao-nulo aqui
    //    significa "ja triado nesta versao de conteudo" (409).
    if (aviso.triagem_veredito != null) {
      throw new HttpError(409, "aviso_ja_triado", "aviso ja triado para o conteudo vigente");
    }

    // 3) Insumos de classificacao (config_automacao = fonte unica + regras duras).
    const [config, regras] = await Promise.all([loadLimiares(db), loadRegrasDuras(db)]);

    // 4) Classificacao server-side determinista (E5 -> limiares -> E12). O Lion
    //    reporta o rotulo (alta/media/baixa); o servidor o traduz na confianca
    //    canonica que alimenta a classificacao e fica persistida em `avisos`.
    const confianca = rotuloParaConfianca(body.rotulo);
    const texto = `${aviso.objeto ?? ""}\n${aviso.conteudo_verbatim ?? ""}`;
    const regrasCasadas = avaliarRegras(texto, regras);
    const produto = body.produto_candidato ?? null;
    let classificacao = classificar(confianca, produto, regrasCasadas, config);

    // 4.1) Gate de RECALL (deterministico): bloqueia o descarte enquanto houver
    //      documento extraivel sem a lista de itens estruturada. Rebaixa
    //      `lixo` -> `duvida` (nunca o contrario). Aplica-se inclusive sobre o
    //      override `fora_de_ramo`: objeto fora do ramo NAO isenta a leitura da
    //      lista (recall total por item). So consulta o banco quando relevante.
    let rebaixadoPorRecall = false;
    if (classificacao.veredito === "lixo" && await temDocExtraivelSemItens(db, aviso.effecti_id)) {
      classificacao = { ...classificacao, veredito: "duvida" };
      rebaixadoPorRecall = true;
    }

    // 4.2) Gate de POLITICA (deterministico): bloqueia `util` quando o produto
    //      candidato tem politica de participacao `nao`. Rebaixa `util` ->
    //      `duvida` (nunca o contrario). So consulta o banco no caso `util` com
    //      candidato presente (util => E12 ja garante produto_id nao-nulo).
    let rebaixadoPorPolitica = false;
    if (
      classificacao.veredito === "util" && produto?.produto_id &&
      await candidatoNaoParticipa(db, produto.produto_id, produto.sku_id ?? null)
    ) {
      classificacao = { ...classificacao, veredito: "duvida" };
      rebaixadoPorPolitica = true;
    }

    const agora = new Date().toISOString();
    const estado = produzirEstadoVigente({
      classificacao,
      confiancaCrua: confianca,
      reabilitado: aviso.reabilitado === true,
      agora,
    });

    // 5) Efeito `util`: favoritar no Effecti ANTES de gravar o estado vigente
    //    (favorito_propagado reflete o resultado best-effort). Falha nao derruba.
    let favoritoPropagado = false;
    if (estado.favoritar) {
      favoritoPropagado = await favoritarEffectiBestEffort(db, aviso);
    }

    // 6) Grava o estado vigente com guarda anti-corrida (`triagem_veredito IS
    //    NULL`): se outra rodada triou no intervalo, 0 linhas -> 409.
    const patch: Record<string, unknown> = { ...estado.patch };
    if (estado.favoritar) {
      patch.favorito = true;
      patch.favorito_propagado = favoritoPropagado;
    }

    const { data: updated, error: upErr } = await db
      .from("avisos")
      .update(patch)
      .eq("id", aviso.id)
      .is("triagem_veredito", null)
      .select("id")
      .maybeSingle();
    if (upErr) {
      throw new Error(`falha ao gravar o estado vigente do aviso: ${upErr.message}`);
    }
    if (!updated) {
      throw new HttpError(409, "aviso_ja_triado", "aviso ja triado para o conteudo vigente");
    }

    // 7) Historico auditavel: uma linha por rodada (inclui agente_versao, E16).
    const { error: decErr } = await db.from("triagem_decisoes").insert({
      aviso_id: aviso.id,
      veredito: estado.veredito,
      confianca: confianca,
      motivo: body.motivo ?? null,
      produto_candidato_id: produto?.produto_id ?? null,
      produto_candidato_nome: produto?.nome ?? null,
      decidido_por: "lia",
      agente_versao: body.agente_versao ?? null,
    });
    if (decErr) {
      throw new Error(`falha ao gravar triagem_decisoes: ${decErr.message}`);
    }

    // 8) Auditoria das acoes sensiveis (favoritar/lixeira). `duvida` nao audita.
    //    Sem conteudo sensivel: apenas principal + veredito + flags de efeito.
    if (estado.favoritar || estado.naLixeira) {
      await logSensitiveAction({
        tabela: "avisos",
        acao: estado.favoritar ? "triagem_favoritar" : "triagem_lixeira",
        registroId: aviso.id,
        usuario: principalLabel(principal),
        dadosNovos: {
          veredito: estado.veredito,
          favorito_propagado: estado.favoritar ? favoritoPropagado : null,
          na_lixeira: estado.naLixeira,
          agente_versao: body.agente_versao ?? null,
        },
      });
    }

    return jsonResponse(
      {
        aviso_id: aviso.id,
        veredito: estado.veredito,
        rotulo: body.rotulo,
        confianca: confianca,
        favoritado: estado.favoritar,
        na_lixeira: estado.naLixeira,
        // true -> o gate de recall rebaixou um `lixo` para `duvida` (havia
        // documento extraivel sem a lista de itens). Sinaliza a Lia/operador a
        // extrair os itens pendentes antes de um eventual descarte.
        rebaixado_por_recall: rebaixadoPorRecall,
        // true -> o gate de politica rebaixou um `util` para `duvida` (o produto
        // candidato tem politica de participacao `nao`). Sinaliza que o match e
        // real mas a DLH nao participa: validacao humana antes de favoritar.
        rebaixado_por_politica: rebaixadoPorPolitica,
      },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
