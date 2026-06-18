// =====================================================================
// Edge Function: v1-triagem-veredito  (Caminho 2 - escrita do veredito cru)
//   -> POST /v1-triagem-veredito
//
// Recebe o veredito CRU do Lion (confianca [0,1] + motivo + produto_candidato)
// e o SERVIDOR classifica server-side (3.2.2 / 3.4): aplica as regras duras
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
} from "../_shared/triagem-ingestao.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "v1-triagem-veredito";

// ---------------------------------------------------------------------
// Validacao do corpo (zod). Body invalido -> 400 (parseJsonBody).
// ---------------------------------------------------------------------

const produtoCandidatoSchema = z.object({
  produto_id: z.string().uuid("produto_id deve ser um uuid valido").nullable(),
  nome: z.string().max(500).nullable(),
});

const veredictoBodySchema = z.object({
  aviso_id: z.string().uuid("aviso_id deve ser um uuid valido"),
  confianca: z.number().min(0, "confianca minima 0").max(1, "confianca maxima 1"),
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

    // 4) Classificacao server-side determinista (E5 -> limiares -> E12).
    const texto = `${aviso.objeto ?? ""}\n${aviso.conteudo_verbatim ?? ""}`;
    const regrasCasadas = avaliarRegras(texto, regras);
    const produto = body.produto_candidato ?? null;
    const classificacao = classificar(body.confianca, produto, regrasCasadas, config);

    const agora = new Date().toISOString();
    const estado = produzirEstadoVigente({
      classificacao,
      confiancaCrua: body.confianca,
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
      confianca: body.confianca,
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
        confianca: body.confianca,
        favoritado: estado.favoritar,
        na_lixeira: estado.naLixeira,
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
