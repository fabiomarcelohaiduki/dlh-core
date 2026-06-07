// =====================================================================
// _shared/notify.ts
// Notificacao proativa de falha por e-mail transacional (US-15, RF-41).
//
//   - sendAlertEmail(): envia e-mail via provedor transacional (Resend HTTP
//     API por padrao; compativel com SMTP-via-HTTP gateways) para os
//     destinatarios de config (ALERT_EMAIL_RECIPIENTS).
//   - notifyHealthcheckFailure() / notifySyncFailure(): disparam APENAS em
//     estado parado (healthcheck = Falha) ou sync que falha por completo.
//     Falhas individuais por item NAO disparam alerta global (RNF-05).
//   - maybeNotifyHealthcheckFalha(): le vw_healthcheck e dispara se Falha.
//
// Best-effort: a notificacao nunca lanca (observabilidade nao pode derrubar
// o fluxo); ausencia de API key/destinatarios vira no-op logado.
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "./env.ts";
import { captureException } from "./audit.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "DLH Core <alertas@dlh-core.local>";

export interface AlertEmail {
  subject: string;
  /** Corpo em texto puro (e tambem usado como fallback do HTML). */
  text: string;
}

export interface SendAlertResult {
  enviado: boolean;
  motivo?: string;
}

/**
 * Envia um e-mail de alerta para os destinatarios configurados. No-op seguro
 * (sem lancar) quando faltam API key ou destinatarios. Injecao de fetch para
 * testabilidade.
 */
export async function sendAlertEmail(
  email: AlertEmail,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SendAlertResult> {
  let apiKey: string | undefined;
  let recipients: string[] = [];
  let from = DEFAULT_FROM;

  try {
    const env = getEnv();
    apiKey = env.emailProviderApiKey;
    recipients = env.alertEmailRecipients;
    from = env.alertEmailFrom ?? DEFAULT_FROM;
  } catch {
    return { enviado: false, motivo: "env_indisponivel" };
  }

  if (!apiKey) {
    console.warn("[notify] EMAIL_PROVIDER_API_KEY ausente; alerta nao enviado");
    return { enviado: false, motivo: "sem_api_key" };
  }
  if (recipients.length === 0) {
    console.warn("[notify] ALERT_EMAIL_RECIPIENTS vazio; alerta nao enviado");
    return { enviado: false, motivo: "sem_destinatarios" };
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  try {
    const res = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: recipients,
        subject: email.subject,
        text: email.text,
      }),
    });

    if (!res.ok) {
      const detail = await safeReadText(res);
      console.error("[notify] provedor de e-mail respondeu erro", {
        status: res.status,
        detail,
      });
      return { enviado: false, motivo: `status_${res.status}` };
    }
    return { enviado: true };
  } catch (err) {
    console.error("[notify] falha ao enviar alerta", {
      err: err instanceof Error ? err.message : String(err),
    });
    await captureException(err, { scope: "notify" });
    return { enviado: false, motivo: "excecao" };
  }
}

/** Alerta de healthcheck em estado de Falha (parado) — RF-41. */
export async function notifyHealthcheckFailure(
  detalhe: { ultimaSync?: string | null; itensComErro?: number } = {},
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SendAlertResult> {
  const linhas = [
    "O healthcheck da ingestao DLH Core entrou em estado de FALHA (parado).",
    "",
    `Ultima sincronizacao bem-sucedida: ${detalhe.ultimaSync ?? "nenhuma"}`,
    `Itens com erro: ${detalhe.itensComErro ?? "n/d"}`,
    "",
    "Verifique as execucoes e os erros de ingestao no cockpit.",
  ];
  return await sendAlertEmail(
    { subject: "[DLH Core] Ingestao em FALHA (parado)", text: linhas.join("\n") },
    deps,
  );
}

/** Alerta de sync que falhou por completo (nenhum item processado) — RF-41. */
export async function notifySyncFailure(
  detalhe: { execucaoId: string; motivo: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SendAlertResult> {
  const linhas = [
    "Uma execucao de coleta DLH Core falhou por completo.",
    "",
    `Execucao: ${detalhe.execucaoId}`,
    `Motivo: ${detalhe.motivo}`,
    "",
    "Nenhum item foi processado nesta execucao. Verifique a fonte e a credencial.",
  ];
  return await sendAlertEmail(
    { subject: "[DLH Core] Falha total na coleta", text: linhas.join("\n") },
    deps,
  );
}

interface HealthcheckRow {
  status_ingestao: string | null;
  ultima_sync: string | null;
  itens_com_erro: number | null;
}

/**
 * Le vw_healthcheck e dispara o alerta de Falha quando o status mapeado e
 * "parado". Usado ao final do pipeline (estado parado pos-execucao). Retorna
 * o resultado do envio (ou no-op quando nao esta em Falha).
 */
export async function maybeNotifyHealthcheckFalha(
  db: SupabaseClient,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SendAlertResult> {
  try {
    const { data, error } = await db
      .from("vw_healthcheck")
      .select("status_ingestao, ultima_sync, itens_com_erro")
      .maybeSingle();

    if (error) {
      console.error("[notify] falha ao ler vw_healthcheck", { error: error.message });
      return { enviado: false, motivo: "healthcheck_query_failed" };
    }

    const row = (data ?? null) as HealthcheckRow | null;
    if (!row || row.status_ingestao !== "parado") {
      return { enviado: false, motivo: "nao_esta_em_falha" };
    }

    return await notifyHealthcheckFailure(
      { ultimaSync: row.ultima_sync, itensComErro: row.itens_com_erro ?? undefined },
      deps,
    );
  } catch (err) {
    console.error("[notify] excecao em maybeNotifyHealthcheckFalha", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { enviado: false, motivo: "excecao" };
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
