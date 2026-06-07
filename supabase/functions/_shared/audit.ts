// =====================================================================
// _shared/audit.ts
// Auditoria de acoes sensiveis (audit_log) + integracao com Sentry.
//
//  - logSensitiveAction(): registra acesso/alteracao sensivel no audit_log
//    via service_role (RNF-08). Falha de auditoria NUNCA derruba o fluxo
//    principal, mas tambem nunca e engolida silenciosamente: vai para
//    console estruturado e Sentry.
//
//  - captureException(): envia excecoes ao Sentry quando SENTRY_DSN esta
//    configurado (envelope/store via fetch, sem dependencia extra). No-op
//    seguro quando o DSN nao existe (ex.: dev local).
// =====================================================================

import { createServiceClient } from "./supabase.ts";
import { getEnv } from "./env.ts";

export interface SensitiveActionInput {
  /** Tabela/recurso afetado (ex.: "avisos"). */
  tabela: string;
  /** acao executada (ex.: "read_detail", "signin", "access_denied"). */
  acao: string;
  /** Id do registro relacionado, quando aplicavel. */
  registroId?: string | null;
  /** E-mail do usuario associado a acao. */
  usuario?: string | null;
  /** Snapshot anterior (para updates/deletes). */
  dadosAnteriores?: Record<string, unknown> | null;
  /** Snapshot novo / contexto da acao. */
  dadosNovos?: Record<string, unknown> | null;
}

/**
 * Registra uma acao sensivel no audit_log. Best-effort: erros sao logados
 * e enviados ao Sentry, sem propagar para nao derrubar o endpoint.
 */
export async function logSensitiveAction(input: SensitiveActionInput): Promise<void> {
  try {
    const service = createServiceClient();
    const { error } = await service.from("audit_log").insert({
      tabela: input.tabela,
      acao: input.acao,
      registro_id: input.registroId ?? null,
      usuario: input.usuario ?? null,
      dados_anteriores: input.dadosAnteriores ?? null,
      dados_novos: input.dadosNovos ?? null,
    });
    if (error) {
      console.error("[audit] falha ao registrar acao sensivel", {
        tabela: input.tabela,
        acao: input.acao,
        error: error.message,
      });
      await captureException(error, { scope: "audit", tabela: input.tabela, acao: input.acao });
    }
  } catch (err) {
    console.error("[audit] excecao inesperada ao auditar", {
      tabela: input.tabela,
      acao: input.acao,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

interface ParsedDsn {
  publicKey: string;
  host: string;
  projectId: string;
}

function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+/, "");
    if (!url.username || !url.host || !projectId) return null;
    return { publicKey: url.username, host: url.host, projectId };
  } catch {
    return null;
  }
}

/**
 * Envia uma excecao ao Sentry quando SENTRY_DSN esta configurado.
 * No-op seguro quando ausente; jamais lanca (observabilidade nao pode
 * quebrar o fluxo de negocio).
 */
export async function captureException(
  error: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  let dsn: string | undefined;
  try {
    dsn = getEnv().sentryDsn;
  } catch {
    // Ambiente sem env valida: nada a enviar.
    return;
  }
  if (!dsn) return;

  const parsed = parseDsn(dsn);
  if (!parsed) {
    console.error("[sentry] SENTRY_DSN invalido; evento nao enviado");
    return;
  }

  try {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const payload = {
      event_id: crypto.randomUUID().replace(/-/g, ""),
      timestamp: new Date().toISOString(),
      platform: "javascript",
      level: "error",
      logger: "dlh-core/edge",
      exception: {
        values: [
          {
            type: error instanceof Error ? error.name : "Error",
            value: message,
            stacktrace: stack ? { frames: [{ function: stack }] } : undefined,
          },
        ],
      },
      extra: context,
    };

    const auth = [
      "Sentry sentry_version=7",
      `sentry_client=dlh-core-edge/1.0`,
      `sentry_key=${parsed.publicKey}`,
    ].join(", ");

    await fetch(`https://${parsed.host}/api/${parsed.projectId}/store/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": auth,
      },
      body: JSON.stringify(payload),
    });
  } catch (sendErr) {
    console.error("[sentry] falha ao enviar evento", {
      err: sendErr instanceof Error ? sendErr.message : String(sendErr),
    });
  }
}
