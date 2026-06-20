// =====================================================================
// Edge Function: v1-documento-itens-gravar  (write path da extracao de itens)
//   -> POST /v1-documento-itens-gravar
//
// A LIA e a extratora dos itens de licitacao (assinatura Lion, modelo forte).
// Ela le o texto JA extraido do documento, identifica a(s) lista(s) de itens e
// posta aqui o resultado. Como a Lia so tem SQL read-only no substrato, este
// recurso de ESCRITA persiste os itens com service_role (espelha o caminho do
// veredito).
//
// PER DOCUMENTO (dedup global): grava itens de UM documento; a fila resolve
// aviso -> documento_vinculos -> documento_itens, reaproveitando entre os N
// avisos que compartilham o mesmo edital. A Lia extrai 1x por documento.
//
// Idempotente: delete-then-insert por documento_id (re-extracao reescreve o
// conjunto). MULTIPLAS LISTAS convivem no mesmo documento via `lista_origem`
// (NUNCA fundir); a descricao de portal vem marcada fonte_descricao='portal'.
//
// FIDELIDADE (Sprint 1, per-documento): antes de gravar `extraido`, o servidor
// VALIDA cada item contra o texto-fonte (documentos.texto, verbatim):
//   - GREP REVERSO: o numero (preco / quantidade grande) precisa ocorrer
//     LITERALMENTE no verbatim, em alguma grafia pt-BR. Roda na RPC
//     documento_verbatim_contem (o verbatim ~4,4M chars NUNCA cruza a rede, B5).
//   - CONFERENCIA DE SOMA: se vier qtd + unitario + total, |qtd*unit - total|
//     tem que ficar dentro de epsilon. (Dormente ate a Lia/MCP enviarem o total;
//     o campo preco_total e opcional e hoje nao chega — ver nota no schema.)
// Item que reprova e gravado MARCADO item_estado='suspeito' (+ suspeito_motivo)
// e enfileirado em documento_item_suspeitas (aceite parcial, recall total —
// NUNCA dropado). A fidelidade NAO trava o documento (segue `extraido`).
//
// O RECALL do Effecti (todo item do piso itensEdital aparece) e per-AVISO e vive
// em v1-triagem-veredito (B1) — NAO aqui (a Edge so conhece o documento_id).
//
// ATOMICIDADE (B2): a validacao e PURA (le verbatim via RPC, sem efeito
// colateral) e roda ANTES de qualquer delete. So depois de decidida a lista
// (com as marcas de suspeito) ocorre delete -> insert -> enfileira -> update.
// Um aborto na validacao nunca deixa o documento vazio.
//
// Status (a Lia define; teto -> inobtenivel e server-side):
//   extraido  -> >=1 item gravado.
//   sem_itens -> documento processado, sem lista de itens (terminal).
//   ignorado  -> documento fora de escopo (proposta/ata/nota/imagem) — terminal.
//   erro      -> falha TRANSITORIA: incrementa tentativas; no teto vira
//                inobtenivel (terminal). Reprocessavel ate la.
//
// Autorizacao na borda (SEC-1): authenticateV1 com `write:triagem` ANTES do
// corpo. Sem credencial -> 401; escopo errado / sessao humana -> 403. Toda a
// escrita roda com service_role.
//
// Codigos: 200 ok; 400 body invalido (zod); 401 sem credencial; 403 escopo
// invalido; 404 documento inexistente.
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, TRIAGEM_WRITE_SCOPE } from "../_shared/service-auth.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { errorMessage, recordIngestErro } from "../_shared/ingest-errors.ts";
import { numeroVariantesBr, parseNumeroBr } from "../_shared/numero-br.ts";
import { colunaSuspeitaDoMotivo, normDesc } from "../_shared/normalizar.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "v1-documento-itens-gravar";

// Teto de tentativas de extracao antes de marcar o documento como inobtenivel.
const TETO_TENTATIVAS = 3;

// Quantidade minima para o grep reverso por NUMERO SOLTO. Abaixo disso o inteiro
// e trivial (item 1, qtd 2, 10 caixas) e casa em qualquer lugar do verbatim ->
// validar por numero solto so geraria ruido (T2 do plano). Precos sao sempre
// conferidos (sao especificos). Quantidades pequenas nao bloqueiam.
const QTD_MIN_GREP = 1000;

// Snapshot da descricao na fila de suspeitas: limita para a fila ficar leve.
const SNAPSHOT_DESC_MAX = 2000;

// ---------------------------------------------------------------------
// Validacao do corpo (zod). Body invalido -> 400 (parseJsonBody).
// ---------------------------------------------------------------------

const itemSchema = z.object({
  // Rotulo livre da lista (corpo do edital vs anexo TR). Distingue MULTIPLAS
  // listas no mesmo documento; o servidor NUNCA funde.
  lista_origem: z.string().min(1).max(200).optional().default("principal"),
  // 'portal' = descricao generica do portal (Comprasnet/PNCP), NAO canonica.
  fonte_descricao: z.enum(["tecnica", "portal"]).optional().default("tecnica"),
  item_numero: z.string().max(200).nullish(),
  lote: z.string().max(200).nullish(),
  // Descricao INTEGRAL do item (sem corte).
  descricao: z.string().min(1, "descricao e obrigatoria").max(20_000),
  unidade: z.string().max(100).nullish(),
  quantidade: z.number().finite().nullish(),
  // Preco UNITARIO de referencia (nullable: nem toda lista traz preco).
  preco_referencia: z.number().finite().nullish(),
  // Preco TOTAL declarado (qtd * unitario), quando o edital o traz. Opcional e
  // FORWARD-COMPATIVEL: habilita a conferencia de soma. Hoje o MCP acervo-triagem
  // nao encaminha este campo (zod do MCP descartaria a chave desconhecida) -> a
  // conferencia de soma fica dormente ate o MCP/Lia passarem a enviar o total.
  preco_total: z.number().finite().nullish(),
  // Proveniencia reportada PELA Lia (opcional). Sem ela -> null nesta Sprint
  // (o MCP ainda nao encaminha o campo). item_estado e SEMPRE server-side.
  item_origem: z.enum(["deterministico", "llm", "effecti"]).nullish(),
  ordem: z.number().int().nullish(),
});

const bodySchema = z.object({
  documento_id: z.string().uuid("documento_id deve ser um uuid valido"),
  status: z.enum(["extraido", "sem_itens", "erro", "ignorado"]),
  itens: z.array(itemSchema).max(2_000).optional().default([]),
  motivo: z.string().max(2_000).nullish(),
}).superRefine((val, ctx) => {
  if (val.status === "extraido" && val.itens.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "status 'extraido' exige ao menos 1 item",
      path: ["itens"],
    });
  }
  if (val.status !== "extraido" && val.itens.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `status '${val.status}' nao aceita itens`,
      path: ["itens"],
    });
  }
});

type GravarBody = z.infer<typeof bodySchema>;
type ItemBody = z.infer<typeof itemSchema>;

// Veredito de fidelidade por item (puro, sem efeito colateral).
interface ItemValidacao {
  suspeito: boolean;
  motivos: string[];
  // Numero que falhou (preco/qtd) para o snapshot da fila; null em soma.
  numeroSuspeito: string | null;
}

// Correcao humana CURADA na fila (status 'corrigido'), pronta para reaplicar
// sobre a re-extracao (A2). Chave = snapshot EXATO da descricao original (como
// gravado em documento_item_suspeitas.item_descricao, ja fatiado).
interface CorrecaoCurada {
  descricao_corrigida: string | null;
  numero_corrigido: string | null;
  motivo: string;
}

// Resultado da validacao: o veredito por item + as correcoes humanas a reaplicar.
interface ResultadoFidelidade {
  validacoes: ItemValidacao[];
  // Chaveado pelo snapshot EXATO da descricao original (it.descricao fatiada em
  // SNAPSHOT_DESC_MAX). A re-extracao reaplica a correcao no item que casar.
  correcoes: Map<string, CorrecaoCurada>;
}

// ---------------------------------------------------------------------
// Validacao de FIDELIDADE (pura: le o verbatim via RPC, NAO escreve nada).
// Roda ANTES de qualquer delete (B2). Devolve, por item (na ordem recebida),
// se ele e suspeito e por que. NUNCA marca suspeito quando nao da para validar
// (sem verbatim, ou numero pequeno trivial) — suspeito so para reprovacao real.
// ---------------------------------------------------------------------

async function validarFidelidade(
  db: ServiceClient,
  documentoId: string,
  itens: ItemBody[],
  temVerbatim: boolean,
): Promise<ResultadoFidelidade> {
  const validacoes: ItemValidacao[] = itens.map(() => ({
    suspeito: false,
    motivos: [],
    numeroSuspeito: null,
  }));
  const correcoes = new Map<string, CorrecaoCurada>();

  // 0) REAPLICACAO DE CURADORIA (Sprint 3): itens que o humano JA revisou na fila
  //    (status confirmado/corrigido/descartado) NAO podem voltar a 'suspeito' a
  //    cada re-extracao. documento_itens e delete-then-insert (ids mudam), entao
  //    o nao-re-marcar e pelo SNAPSHOT da descricao (normDesc). Leitura pura.
  //    Alem disso, as linhas 'corrigido' carregam o valor humano (descricao /
  //    numero corrigido) -> a re-extracao REAPLICA esse valor sobre o item que
  //    casar pelo snapshot EXATO da descricao (A2). Chave exata (nao normDesc)
  //    para nao reaplicar a correcao no item errado quando prefixos colidem.
  const cleared = new Set<string>();
  const { data: curadas, error: curErr } = await db
    .from("documento_item_suspeitas")
    .select("item_descricao, status, descricao_corrigida, numero_corrigido, motivo")
    .eq("documento_id", documentoId)
    .eq("tipo", "fidelidade")
    .in("status", ["confirmado", "corrigido", "descartado"]);
  if (curErr) {
    throw new Error(`falha ao ler curadoria de suspeitas: ${curErr.message}`);
  }
  for (
    const c of (curadas ?? []) as {
      item_descricao: string | null;
      status: string;
      descricao_corrigida: string | null;
      numero_corrigido: string | null;
      motivo: string;
    }[]
  ) {
    const d = normDesc(c.item_descricao);
    if (d.length > 0) cleared.add(d);
    // Correcao reaplicavel: precisa do snapshot exato (chave de casamento) e de
    // ao menos um valor corrigido. So a ultima vence se houver snapshot repetido.
    if (
      c.status === "corrigido" &&
      c.item_descricao &&
      ((c.descricao_corrigida ?? "").trim() || (c.numero_corrigido ?? "").trim())
    ) {
      correcoes.set(c.item_descricao, {
        descricao_corrigida: c.descricao_corrigida,
        numero_corrigido: c.numero_corrigido,
        motivo: c.motivo,
      });
    }
  }

  // 1) Monta as agulhas do grep (preco sempre; quantidade so se grande) e o
  //    conjunto unico a procurar no verbatim. Grafias pt-BR por numero.
  const agulhasPorItem: { precos: string[]; qtds: string[] }[] = itens.map((it) => {
    const precos = typeof it.preco_referencia === "number"
      ? numeroVariantesBr(it.preco_referencia)
      : [];
    const qtds = typeof it.quantidade === "number" && it.quantidade >= QTD_MIN_GREP
      ? numeroVariantesBr(it.quantidade)
      : [];
    return { precos, qtds };
  });

  // 2) Grep reverso (so quando ha verbatim e ao menos uma agulha). O verbatim
  //    fica no banco; a RPC devolve apenas as agulhas presentes (B5).
  let presentes = new Set<string>();
  if (temVerbatim) {
    const todas = new Set<string>();
    for (const a of agulhasPorItem) {
      for (const n of a.precos) todas.add(n);
      for (const n of a.qtds) todas.add(n);
    }
    if (todas.size > 0) {
      const { data, error } = await db.rpc("documento_verbatim_contem", {
        p_documento_id: documentoId,
        p_agulhas: [...todas],
      });
      if (error) {
        // Validacao e pre-delete: propagar o erro mantem a atomicidade (nada
        // foi apagado ainda). 500 -> a Lia re-tenta sem perder itens anteriores.
        throw new Error(`falha no grep reverso (documento_verbatim_contem): ${error.message}`);
      }
      presentes = new Set<string>((data ?? []) as string[]);
    }
  }

  // 3) Decisao por item: grep (preco / qtd grande) + conferencia de soma.
  itens.forEach((it, i) => {
    const v = validacoes[i];
    // Item ja curado pelo humano (reaplicacao): nao re-marca suspeito nem
    // reenfileira — respeita a revisao anterior atraves da re-extracao.
    if (cleared.has(normDesc(it.descricao))) return;
    const { precos, qtds } = agulhasPorItem[i];

    // Preco: so reprova quando HA verbatim para conferir (senao nao da para
    // afirmar ausencia). Nenhuma grafia presente -> suspeito.
    if (temVerbatim && precos.length > 0 && !precos.some((n) => presentes.has(n))) {
      v.suspeito = true;
      v.motivos.push(`preco ${it.preco_referencia} ausente no texto-fonte`);
      v.numeroSuspeito = v.numeroSuspeito ?? String(it.preco_referencia);
    }

    // Quantidade grande: idem (pequenas nao entram em agulhasPorItem -> T2).
    if (temVerbatim && qtds.length > 0 && !qtds.some((n) => presentes.has(n))) {
      v.suspeito = true;
      v.motivos.push(`quantidade ${it.quantidade} ausente no texto-fonte`);
      v.numeroSuspeito = v.numeroSuspeito ?? String(it.quantidade);
    }

    // Conferencia de soma (independe do verbatim): qtd * unitario == total.
    if (
      typeof it.quantidade === "number" &&
      typeof it.preco_referencia === "number" &&
      typeof it.preco_total === "number"
    ) {
      const esperado = it.quantidade * it.preco_referencia;
      const tol = Math.max(0.02, Math.abs(it.preco_total) * 0.005);
      if (Math.abs(esperado - it.preco_total) > tol) {
        v.suspeito = true;
        v.motivos.push(
          `soma diverge (qtd ${it.quantidade} x unitario ${it.preco_referencia} = ` +
            `${esperado.toFixed(2)} != total ${it.preco_total})`,
        );
      }
    }
  });

  return { validacoes, correcoes };
}

// ---------------------------------------------------------------------
// Reconciliacao + enfileiramento das suspeitas de FIDELIDADE (best-effort).
// delete-then-insert das pendentes do documento: re-extracao que corrigiu o
// numero limpa a suspeita antiga; as ja curadas (status != pendente) sobrevivem.
// NUNCA derruba a gravacao (os itens ja foram persistidos, marcados).
// ---------------------------------------------------------------------

async function reconciliarSuspeitasFidelidade(
  db: ServiceClient,
  documentoId: string,
  suspeitas: {
    documento_item_id: string | null;
    item_descricao: string;
    numero_suspeito: string | null;
    motivo: string;
  }[],
): Promise<void> {
  try {
    // Limpa as pendentes deste documento (reconciliacao: nao duplica linha
    // pendente para o mesmo conteudo; curadas permanecem).
    const { error: delErr } = await db
      .from("documento_item_suspeitas")
      .delete()
      .eq("documento_id", documentoId)
      .eq("tipo", "fidelidade")
      .eq("status", "pendente");
    if (delErr) {
      throw new Error(`falha ao limpar suspeitas pendentes: ${delErr.message}`);
    }

    if (suspeitas.length === 0) return;

    const rows = suspeitas.map((s) => ({
      aviso_id: null,
      documento_id: documentoId,
      documento_item_id: s.documento_item_id,
      tipo: "fidelidade",
      item_descricao: s.item_descricao.slice(0, SNAPSHOT_DESC_MAX),
      numero_suspeito: s.numero_suspeito,
      motivo: s.motivo,
    }));
    const { error: insErr } = await db.from("documento_item_suspeitas").insert(rows);
    if (insErr) {
      throw new Error(`falha ao enfileirar suspeitas: ${insErr.message}`);
    }
  } catch (err) {
    // Best-effort: o item ja esta marcado em documento_itens (item_estado).
    await recordIngestErro(db, {
      severidade: "media",
      etapa: "Persistencia",
      registroId: documentoId,
      mensagem: `suspeitas de fidelidade nao enfileiradas: ${errorMessage(err)}`,
    });
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
    await authenticateV1(req, { requiredScope: TRIAGEM_WRITE_SCOPE });

    const body: GravarBody = await parseJsonBody(req, bodySchema);
    const db: ServiceClient = createServiceClient();

    // 1) Documento existe? (404 quando inexistente). texto_chars gate o grep
    //    reverso SEM puxar o verbatim (B5): > 0 = ha texto-fonte para conferir.
    const { data: docRaw, error: docErr } = await db
      .from("documentos")
      .select("id, itens_tentativas, texto_chars, ocr_baixa_confianca")
      .eq("id", body.documento_id)
      .maybeSingle();
    if (docErr) {
      throw new Error(`falha ao consultar o documento: ${docErr.message}`);
    }
    if (!docRaw) {
      throw new HttpError(404, "documento_nao_encontrado", "documento inexistente");
    }
    // Grep reverso da fidelidade exige verbatim CONFIAVEL. OCR de baixa confianca
    // (Sprint 4) corrompe o numero -> desliga o grep (gate de qualidade precede o
    // grep); a conferencia de soma e o flag de revisao humana seguem valendo.
    const ocrBaixa = docRaw.ocr_baixa_confianca === true;
    const temVerbatim = Number(docRaw.texto_chars ?? 0) > 0 && !ocrBaixa;

    const agora = new Date().toISOString();

    // 2) Erro TRANSITORIO: incrementa tentativas; no teto vira inobtenivel
    //    (terminal). Nao toca nos itens ja gravados.
    if (body.status === "erro") {
      const tentativas = Number(docRaw.itens_tentativas ?? 0) + 1;
      const statusFinal = tentativas >= TETO_TENTATIVAS ? "inobtenivel" : "erro";
      const { error } = await db
        .from("documentos")
        .update({ itens_status: statusFinal, itens_tentativas: tentativas })
        .eq("id", body.documento_id);
      if (error) {
        throw new Error(`falha ao marcar erro de extracao: ${error.message}`);
      }
      return jsonResponse(
        { documento_id: body.documento_id, status: statusFinal, tentativas, itens_gravados: 0 },
        200,
      );
    }

    // 3) FIDELIDADE — validacao PURA (le verbatim via RPC; NAO escreve), ANTES
    //    de qualquer delete (B2). Se a RPC falhar, propaga 500 com os itens
    //    anteriores intactos (nada foi apagado).
    const { validacoes, correcoes } = body.status === "extraido" && body.itens.length > 0
      ? await validarFidelidade(db, body.documento_id, body.itens, temVerbatim)
      : {
        validacoes: body.itens.map(() => ({ suspeito: false, motivos: [], numeroSuspeito: null })),
        correcoes: new Map<string, CorrecaoCurada>(),
      };

    // 4) extraido / sem_itens / ignorado: idempotente — zera os itens do
    //    documento e regrava o conjunto recem-extraido (so AGORA, pos-validacao).
    const { error: delErr } = await db
      .from("documento_itens")
      .delete()
      .eq("documento_id", body.documento_id);
    if (delErr) {
      throw new Error(`falha ao limpar itens anteriores: ${delErr.message}`);
    }

    let gravados = 0;
    let suspeitosCount = 0;
    // Itens recem-inseridos (id + chaves de correlacao). Permite ao chamador
    // referenciar o documento_item_id de itens que ELE acabou de extrair (ainda
    // nao estavam na fila) — necessario para persistir match por item no mesmo
    // run (ex.: PDF extraido na primeira triagem, que nao retorna a fila depois).
    let itensInseridos: { id: string; lista_origem: string; ordem: number | null }[] = [];
    if (body.itens.length > 0) {
      const rows = body.itens.map((it, i) => {
        // A2: reaplica a correcao humana CURADA (status 'corrigido') sobre a
        // re-extracao. Casamento por snapshot EXATO da descricao original (a
        // mesma que a Lia re-extrai a cada run) -> nao reaplica no item errado
        // quando prefixos colidem. A coluna do numero corrigido vem do motivo.
        const correcao = correcoes.get(it.descricao.slice(0, SNAPSHOT_DESC_MAX));
        let descricao = it.descricao;
        let quantidade = it.quantidade ?? null;
        let precoReferencia = it.preco_referencia ?? null;
        if (correcao) {
          const descCorr = (correcao.descricao_corrigida ?? "").trim();
          if (descCorr) descricao = descCorr;
          const numCorr = (correcao.numero_corrigido ?? "").trim();
          if (numCorr) {
            const valor = parseNumeroBr(numCorr);
            const coluna = colunaSuspeitaDoMotivo(correcao.motivo);
            if (valor !== null && coluna === "preco_referencia") precoReferencia = valor;
            if (valor !== null && coluna === "quantidade") quantidade = valor;
          }
        }
        return {
          documento_id: body.documento_id,
          lista_origem: it.lista_origem,
          fonte_descricao: it.fonte_descricao,
          item_numero: it.item_numero ?? null,
          lote: it.lote ?? null,
          descricao,
          unidade: it.unidade ?? null,
          quantidade,
          preco_referencia: precoReferencia,
          ordem: it.ordem ?? i + 1,
          // FIDELIDADE server-side (decisao 3/4): uma POST da Lia = revisao
          // concluida -> 'revisado'; item reprovado -> 'suspeito' + motivo. Item
          // com correcao humana curada (A2) e sempre 'revisado' (nunca suspeito).
          item_estado: correcao ? "revisado" : (validacoes[i].suspeito ? "suspeito" : "revisado"),
          item_origem: it.item_origem ?? null,
          suspeito_motivo: !correcao && validacoes[i].suspeito
            ? validacoes[i].motivos.join("; ")
            : null,
        };
      });
      const { data: ins, error: insErr } = await db
        .from("documento_itens")
        .insert(rows)
        .select("id, lista_origem, ordem");
      if (insErr) {
        throw new Error(`falha ao inserir itens: ${insErr.message}`);
      }
      itensInseridos = (ins ?? []) as typeof itensInseridos;
      gravados = rows.length;
      suspeitosCount = validacoes.filter((v) => v.suspeito).length;
    }

    // 5) Suspeitas de fidelidade: reconcilia (sempre, p/ limpar pendentes
    //    obsoletas pos re-extracao) e enfileira as desta rodada (best-effort).
    //    O link documento_item_id e por posicao (insert preserva a ordem);
    //    o snapshot e a fonte de verdade resiliente.
    const suspeitas = body.itens
      .map((it, i) => ({ it, i, v: validacoes[i] }))
      .filter(({ v }) => v.suspeito)
      .map(({ it, i, v }) => ({
        documento_item_id: itensInseridos[i]?.id ?? null,
        item_descricao: it.descricao,
        numero_suspeito: v.numeroSuspeito,
        motivo: v.motivos.join("; "),
      }));
    await reconciliarSuspeitasFidelidade(db, body.documento_id, suspeitas);

    const { error: upErr } = await db
      .from("documentos")
      .update({ itens_status: body.status, itens_extraido_em: agora })
      .eq("id", body.documento_id);
    if (upErr) {
      throw new Error(`falha ao atualizar status do documento: ${upErr.message}`);
    }

    return jsonResponse(
      {
        documento_id: body.documento_id,
        status: body.status,
        itens_gravados: gravados,
        // Quantos itens foram gravados MARCADOS como suspeitos de fidelidade
        // (recall total — nenhum foi dropado). 0 = lista integra.
        itens_suspeitos: suspeitosCount,
        itens: itensInseridos,
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
