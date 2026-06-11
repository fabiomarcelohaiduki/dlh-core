// =====================================================================
// Edge Function: gmail-execucao  ->  POST /gmail-execucao
// Registra a EXECUCAO da coleta do Gmail no banco (tabela execucoes), para
// que a coleta apareca no painel (Dashboard/Execucoes) e o card da fonte
// reflita "coleta em andamento" — igual Nomus/Effecti.
//
// POR QUE UM EDGE: o Gmail coleta num runner Node do GitHub Actions (a lista
// de mensagens e a credencial Google so existem la). Diferente de Nomus/
// Effecti, o fluxo do Gmail (descobrir-gmail.mjs) so enfileira documentos e
// NAO criava execucao. O runner nao tem service_role (so o X-Cron-Secret),
// entao a escrita em execucoes (RLS) passa por este Edge com service_role.
//
// AUTH: apenas chamador SISTEMA (runner) via X-Cron-Secret. Sem sessao humana.
//
// ACOES (campo 'action' no body):
//   'abrir'   Cria a execucao em_andamento (lock-por-fonte: se ja houver uma
//             em andamento da fonte gmail, devolve a corrente com
//             ja_em_andamento=true em vez de criar outra). Responde
//             { execucao_id, ja_em_andamento }.
//   'fechar'  Fecha a execucao (status concluida|erro, fim=now, contagens).
//             Body: { execucao_id, status, total?, sucesso?, erro? }.
//             Em 'concluida' AVANCA as marcas d'agua da janela incremental do
//             gmail_config: coletado_ate = hoje (frente cobriu ate agora) e
//             coletado_desde = min(coletado_desde, data_inicial) (se houve
//             backfill, recua p/ a nova data). Em 'erro' nao mexe nas marcas
//             (o proximo run re-varre a mesma janela; o dedup da fila protege).
//   'fechar-orfa'  Fecha como 'erro' QUALQUER execucao em_andamento da fonte
//             gmail (auto-cura). Chamado num step de cleanup if:always() do
//             workflow: quando o run e CANCELADO o Node morre por sinal e o
//             try/catch do script nao roda, deixando a execucao pendurada. O
//             concurrency 'coletar-gmail' garante 1 run por vez, entao toda
//             em_andamento aqui e desta run (ou orfa anterior) -> seguro fechar.
//             No fim normal a execucao ja esta 'concluida' -> no-op.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { matchesCronSecret } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Resolve o id da fonte gmail (ancora do agendamento/execucoes). */
async function loadGmailFonteId(service: ServiceClient): Promise<string> {
  const { data, error } = await service
    .from("fontes")
    .select("id")
    .eq("tipo", "gmail")
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "fonte_query_failed", "falha ao resolver a fonte gmail");
  }
  const id = (data as { id?: string } | null)?.id;
  if (!id) {
    throw new HttpError(404, "fonte_nao_encontrada", "fonte gmail nao cadastrada");
  }
  return id;
}

/** Cria a execucao em_andamento (ou devolve a corrente, lock-por-fonte). */
async function abrir(service: ServiceClient, gatilho: string): Promise<Response> {
  const fonteId = await loadGmailFonteId(service);

  // Lock-por-fonte: nao cria uma 2a execucao se a fonte ja coleta (espelha
  // Nomus/Effecti; o 409 do dispatch e a defesa real contra duplo-disparo).
  const { data: emAndamento, error: lockErr } = await service
    .from("execucoes")
    .select("id")
    .eq("fonte_id", fonteId)
    .eq("status", "em_andamento")
    .limit(1);
  if (lockErr) {
    throw new HttpError(500, "execucao_query_failed", "falha ao verificar execucoes em andamento");
  }
  if (emAndamento && emAndamento.length > 0) {
    const corrente = emAndamento[0] as { id: string };
    return jsonResponse({ execucao_id: String(corrente.id), ja_em_andamento: true }, 200);
  }

  const { data: execucao, error: insError } = await service
    .from("execucoes")
    .insert({
      inicio: new Date().toISOString(),
      gatilho: gatilho === "manual" ? "manual" : "agendada",
      fonte_id: fonteId,
      status: "em_andamento",
      etapa_atual: "coleta",
      total_processar: 0,
      processados_sucesso: 0,
      processados_erro: 0,
      pendentes: 0,
    })
    .select("id")
    .single();
  if (insError || !execucao) {
    // Corrida perdida no indice unico parcial (uidx_execucoes_uma_ativa_por_fonte):
    // outra coleta gmail nasceu entre o check e o insert -> devolve a corrente.
    if (insError?.code === "23505") {
      const { data: corrente } = await service
        .from("execucoes")
        .select("id")
        .eq("fonte_id", fonteId)
        .eq("status", "em_andamento")
        .limit(1)
        .maybeSingle();
      return jsonResponse(
        { execucao_id: corrente ? String((corrente as { id: string }).id) : "", ja_em_andamento: true },
        200,
      );
    }
    throw new HttpError(500, "execucao_insert_failed", "falha ao criar a execucao");
  }
  return jsonResponse({ execucao_id: String((execucao as { id: string }).id), ja_em_andamento: false }, 201);
}

/**
 * Fecha como 'erro' todas as execucoes em_andamento da fonte gmail (auto-cura
 * de orfa apos cancelamento do run). Idempotente: se nao houver orfa, no-op.
 */
async function fecharOrfa(service: ServiceClient): Promise<Response> {
  const fonteId = await loadGmailFonteId(service);
  const { data, error } = await service
    .from("execucoes")
    .update({ status: "erro", fim: new Date().toISOString(), etapa_atual: null })
    .eq("fonte_id", fonteId)
    .eq("status", "em_andamento")
    .select("id");
  if (error) {
    throw new HttpError(500, "execucao_update_failed", "falha ao fechar execucoes orfas");
  }
  const fechadas = Array.isArray(data) ? data.length : 0;
  return jsonResponse({ ok: true, fechadas }, 200);
}

/**
 * Avanca as marcas d'agua da janela incremental do gmail_config apos uma coleta
 * concluida: coletado_ate = hoje (a frente cobriu ate agora) e coletado_desde =
 * min(coletado_desde, data_inicial) (recua se houve backfill de ANTIGOS).
 * Best-effort: falha aqui nao derruba o fechamento da execucao (so loga).
 */
async function avancarMarcas(service: ServiceClient): Promise<void> {
  const { data: cfg, error: cfgErr } = await service
    .from("gmail_config")
    .select("data_inicial, coletado_desde")
    .eq("id", true)
    .maybeSingle();
  if (cfgErr || !cfg) {
    console.error("AVISO: gmail-execucao nao leu gmail_config p/ avancar marcas:", cfgErr?.message);
    return;
  }
  const dataInicial = ((cfg.data_inicial as string | null) ?? "").slice(0, 10) || null;
  const desde = ((cfg.coletado_desde as string | null) ?? "").slice(0, 10) || null;
  const hoje = new Date().toISOString().slice(0, 10);

  // min lexicografico ('YYYY-MM-DD' ordena por data). null => assume data_inicial.
  let novoDesde = desde;
  if (dataInicial && (!novoDesde || dataInicial < novoDesde)) novoDesde = dataInicial;

  const { error: updErr } = await service
    .from("gmail_config")
    .update({ coletado_ate: hoje, coletado_desde: novoDesde, atualizado_em: new Date().toISOString() })
    .eq("id", true);
  if (updErr) {
    console.error("AVISO: gmail-execucao falhou ao avancar marcas:", updErr.message);
  }
}

/** Formata milissegundos em duracao legivel (ex.: "1m 23s"), igual Effecti/Nomus. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Fecha a execucao (status final + contagens). */
async function fechar(
  service: ServiceClient,
  execucaoId: string,
  status: "concluida" | "erro",
  total: number,
  sucesso: number,
  erro: number,
  novos: number,
): Promise<Response> {
  // Le `inicio` p/ derivar a duracao no mesmo formato das outras fontes (a
  // coluna `duracao` e denormalizada: Effecti/Nomus ja gravam no fechar).
  const { data: row } = await service
    .from("execucoes")
    .select("inicio")
    .eq("id", execucaoId)
    .single();
  const fim = new Date();
  const inicioMs = row?.inicio ? new Date(row.inicio as string).getTime() : null;
  const duracao = inicioMs !== null ? formatDuration(fim.getTime() - inicioMs) : null;

  const { error: updError } = await service
    .from("execucoes")
    .update({
      status,
      fim: fim.toISOString(),
      etapa_atual: null,
      total_processar: total,
      processados_sucesso: sucesso,
      processados_erro: erro,
      // `novos` = itens ineditos enfileirados (apos dedup da fila). A descoberta
      // Gmail nao ingere documentos, entao `alterados` segue 0; sem este campo
      // a execucao caia sempre em "sem novos" mesmo tendo enfileirado itens.
      novos,
      duracao,
      pendentes: 0,
    })
    .eq("id", execucaoId);
  if (updError) {
    throw new HttpError(500, "execucao_update_failed", "falha ao fechar a execucao");
  }

  // So uma coleta concluida com sucesso avanca a janela (erro re-varre depois).
  if (status === "concluida") {
    await avancarMarcas(service);
  }

  return jsonResponse({ ok: true, execucao_id: execucaoId, status }, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Apenas chamador SISTEMA (runner do Actions) via cron secret.
    if (!(await matchesCronSecret(req))) {
      throw new HttpError(401, "cron_unauthorized", "autenticacao interna requerida");
    }

    let input: Record<string, unknown>;
    try {
      input = (await req.json()) as Record<string, unknown>;
    } catch (_) {
      throw new HttpError(400, "invalid_body", "corpo JSON invalido");
    }

    const service = createServiceClient();
    const action = String(input.action ?? "");

    if (action === "abrir") {
      return await abrir(service, String(input.gatilho ?? "agendada"));
    }

    if (action === "fechar-orfa") {
      return await fecharOrfa(service);
    }

    if (action === "fechar") {
      const execucaoId = String(input.execucao_id ?? "").trim();
      if (!execucaoId) {
        throw new HttpError(400, "execucao_id_ausente", "execucao_id obrigatorio para fechar");
      }
      const status = input.status === "erro" ? "erro" : "concluida";
      const toInt = (v: unknown) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
      };
      return await fechar(
        service,
        execucaoId,
        status,
        toInt(input.total),
        toInt(input.sucesso),
        toInt(input.erro),
        toInt(input.novos),
      );
    }

    throw new HttpError(400, "acao_invalida", "action deve ser 'abrir', 'fechar' ou 'fechar-orfa'");
  } catch (err) {
    return await errorResponse(err, { fn: "gmail-execucao" });
  }
}

getEnv();

Deno.serve(handler);
