// =====================================================================
// Edge Function: comando-local-enfileirar
//   POST /comando-local-enfileirar  -> enfileira um comando para o PC local
//   GET  /comando-local-enfileirar  -> lista os comandos recentes (status)
//
// POR QUE EXISTE (decisao Fabio 2026-06-28):
//   Pos-bloqueio do GitHub Actions, a coleta Nomus e a extracao Tika/OCR rodam
//   no PC do Fabio (Agendador do Windows), sem botao de disparo no cockpit. Esta
//   Edge e a PONTA DO COCKPIT do quadro de avisos: o cockpit insere um comando
//   'pendente' (POST) e acompanha o ciclo de vida (GET). Quem EXECUTA e o
//   servico de poll do PC (Edge comando-local-fila). Aqui nao roda nada local.
//
// AUTORIZACAO: sessao do cockpit (requireAuthorizedUser) + audit no POST. O
//   acesso a tabela e por service_role (RLS sem policy). verify_jwt fica LIGADO
//   (default) -> so usuario logado enfileira/le.
//
// ANTI-DUPLO-DISPARO: 409 se ja existe o MESMO comando pendente ou executando
//   (evita empilhar duas coletas iguais por clique rapido).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

const COMANDOS_VALIDOS = [
  "nomus-processos",
  "nomus-pessoas",
  "nomus-processos-full",
  "tika-ocr",
] as const;
type ComandoTipo = (typeof COMANDOS_VALIDOS)[number];

function ehComandoValido(v: unknown): v is ComandoTipo {
  return typeof v === "string" && (COMANDOS_VALIDOS as readonly string[]).includes(v);
}

/** POST: valida o comando, barra duplicata pendente/executando e insere 'pendente'. */
async function enfileirar(req: Request, service: ReturnType<typeof createServiceClient>): Promise<Response> {
  const { email } = await requireAuthorizedUser(req);

  let body: { comando?: unknown };
  try {
    body = await req.json();
  } catch (_) {
    throw new HttpError(400, "body_invalido", "corpo JSON invalido");
  }
  if (!ehComandoValido(body.comando)) {
    throw new HttpError(
      400,
      "comando_invalido",
      "comando deve ser nomus-processos, nomus-pessoas, nomus-processos-full ou tika-ocr",
    );
  }
  const comando = body.comando;

  // Anti-duplo-disparo: nao empilha o mesmo comando se um ja esta na fila/rodando.
  const { data: ativos, error: ativosErr } = await service
    .from("comando_local")
    .select("id")
    .eq("comando", comando)
    .in("status", ["pendente", "executando"])
    .limit(1);
  if (ativosErr) {
    throw new HttpError(500, "fila_query_failed", "falha ao verificar a fila de comandos");
  }
  if (ativos && ativos.length > 0) {
    throw new HttpError(409, "comando_em_andamento", "esse comando ja esta na fila ou em execucao");
  }

  const { data: inserido, error: insertErr } = await service
    .from("comando_local")
    .insert({ comando, solicitado_por: email })
    .select("id, comando, status, solicitado_em")
    .single();
  if (insertErr || !inserido) {
    throw new HttpError(500, "fila_insert_failed", "falha ao enfileirar o comando");
  }

  await logSensitiveAction({
    tabela: "comando_local",
    acao: "enfileirar_comando_local",
    registroId: inserido.id,
    usuario: email,
    dadosNovos: { comando },
  });

  // 202 Accepted: comando aceito; o PC o pega no proximo poll.
  return jsonResponse({ ok: true, comando: inserido }, 202);
}

/** GET: lista os comandos recentes para o cockpit acompanhar o status. */
async function listar(req: Request, service: ReturnType<typeof createServiceClient>): Promise<Response> {
  await requireAuthorizedUser(req);

  const { data, error } = await service
    .from("comando_local")
    .select("id, comando, status, solicitado_por, solicitado_em, iniciado_em, terminado_em, resultado")
    .order("solicitado_em", { ascending: false })
    .limit(20);
  if (error) {
    throw new HttpError(500, "fila_list_failed", "falha ao listar os comandos");
  }

  return jsonResponse({ comandos: data ?? [] });
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    const service = createServiceClient();
    if (req.method === "POST") return await enfileirar(req, service);
    if (req.method === "GET") return await listar(req, service);
    throw new HttpError(405, "metodo_nao_permitido", "use GET ou POST");
  } catch (err) {
    return await errorResponse(err, { fn: "comando-local-enfileirar" });
  }
}

getEnv();

Deno.serve(handler);
