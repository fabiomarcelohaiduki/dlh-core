// =====================================================================
// Edge Function: fontes-testar  ->  POST /fontes-testar
// Testa a conexao com a fonte usando a credencial do Vault (US-03/US-07).
// Parametrizado por fonte (effecti|nomus) — RF-11/US-03.
//
//   - Autoriza a sessao (requireAuthorizedUser) e valida o corpo zod
//     { fonte } enum {effecti,nomus}. Valor desconhecido -> 422 sem I/O.
//   - Le o segredo do Vault em RUNTIME (nunca de .env, nunca do cliente) e
//     faz uma requisicao LEVE (ex.: Nomus GET /rest/processos?pagina=1).
//   - Classifica a causa: 401->unauthorized, 429->rate_limited,
//     timeout->timeout, credencial ausente->estado nao_configurada (com
//     orientacao), demais->unknown.
//   - Atualiza fontes.estado_conexao e audita SEM segredo (o header Basic
//     NUNCA e logado — SEC-01).
//   - Responde { estado_conexao, causa, mensagem, latencia_ms } (mantendo
//     tambem estadoConexao/latenciaMs legados para o cockpit).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { getFonteByTipo, getFonteSecret, updateFonteEstado } from "../_shared/vault.ts";
import {
  ConnectionTestError,
  createConnector,
  type TestFailureCause,
} from "../_shared/effecti-connector.ts";
import { parseJsonBody, testarConexaoSchema } from "../_shared/validation.ts";
import type { TestarConexaoResult } from "../_shared/types.ts";

/** Formata um ISO em data/hora curta BR (America/Sao_Paulo) para a copy. */
function formatBrDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
}

/** Mensagem por causa de falha, espelhando a copy do bloco Effecti (4.5.1). */
function messageForCause(cause: TestFailureCause, fonteNome: string): string {
  switch (cause) {
    case "timeout":
      return `tempo de resposta excedido ao contatar o ${fonteNome} (timeout)`;
    case "unauthorized":
      return `credencial ${fonteNome} invalida ou expirada (401)`;
    case "rate_limited":
      return `limite de requisicoes do ${fonteNome} atingido (429), tente novamente em instantes`;
    default:
      return `falha ao conectar ao ${fonteNome}, tente novamente`;
  }
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao primeiro (SEC-02); corpo validado por allowlist (SEC-03).
    const { email } = await requireAuthorizedUser(req);
    const { fonte } = await parseJsonBody(req, testarConexaoSchema, { validationStatus: 422 });

    const fonteRecord = await getFonteByTipo(fonte);

    // Credencial ausente -> estado nao_configurada (orienta o onboarding).
    const token = await getFonteSecret(fonteRecord.id);
    if (!token) {
      await updateFonteEstado(fonteRecord.id, "nao_configurada");
      await logSensitiveAction({
        tabela: "fontes",
        acao: "testar_conexao",
        registroId: fonteRecord.id,
        usuario: email,
        dadosNovos: {
          fonte: fonteRecord.tipo,
          resultado: "nao_configurada",
          motivo: "credencial_ausente",
        },
      });

      const body: TestarConexaoResult = {
        estadoConexao: "nao_configurada",
        latenciaMs: 0,
        estado_conexao: "nao_configurada",
        causa: "nao_configurada",
        mensagem:
          `credencial ${fonteRecord.nome} nao configurada: salve a chave de integracao antes de testar`,
        latencia_ms: 0,
      };
      return jsonResponse(body, 200);
    }

    // -----------------------------------------------------------------
    // NOMUS: o teste NAO roda via Edge. O Nomus (famaha.nomus.com.br) so
    // aceita TLS 1.2 com cifra CBC legada (ECDHE-RSA-AES256-SHA384), que o
    // Deno (rustls) do Edge rejeita -> handshake failure. Um handshake direto
    // daria SEMPRE falso-negativo "Erro de conexao". A coleta real roda num
    // runner Node (OpenSSL, GitHub Actions) e faz PUSH via nomus-ingerir; logo
    // a saude da conexao Nomus e derivada da ULTIMA COLETA na nuvem.
    // -----------------------------------------------------------------
    if (fonteRecord.tipo === "nomus") {
      const ultima = fonteRecord.ultimaColetaEm;
      const resultado = ultima ? "conectada" : "pendente_coleta";
      if (ultima) {
        await updateFonteEstado(fonteRecord.id, "conectada");
      }
      await logSensitiveAction({
        tabela: "fontes",
        acao: "testar_conexao",
        registroId: fonteRecord.id,
        usuario: email,
        dadosNovos: { fonte: fonteRecord.tipo, resultado, via: "coleta_nuvem" },
      });
      const body: TestarConexaoResult = ultima
        ? {
          estadoConexao: "conectada",
          latenciaMs: 0,
          estado_conexao: "conectada",
          causa: null,
          mensagem:
            `${fonteRecord.nome} validado pela ultima coleta na nuvem (runner) em ${
              formatBrDateTime(ultima)
            }. O teste direto nao roda no Edge por incompatibilidade de TLS do Nomus.`,
          latencia_ms: 0,
        }
        : {
          // Sem coleta concluida ainda: nao ha como provar a conexao pelo Edge.
          // NAO marca 'erro' (evita o falso-negativo); mantem o estado corrente.
          estadoConexao: fonteRecord.estadoConexao,
          latenciaMs: 0,
          estado_conexao: fonteRecord.estadoConexao,
          causa: null,
          mensagem:
            `Credencial salva. A conexao do ${fonteRecord.nome} e validada pela coleta na nuvem (runner Node), nao por teste direto no Edge (TLS legado). Aguardando a primeira coleta concluir.`,
          latencia_ms: 0,
        };
      return jsonResponse(body, 200);
    }

    const connector = createConnector(fonteRecord.tipo, {
      endpointBase: fonteRecord.endpointBase,
      token,
    });

    try {
      const { estadoConexao, latenciaMs } = await connector.testConnection();
      await updateFonteEstado(fonteRecord.id, estadoConexao);
      await logSensitiveAction({
        tabela: "fontes",
        acao: "testar_conexao",
        registroId: fonteRecord.id,
        usuario: email,
        dadosNovos: { fonte: fonteRecord.tipo, resultado: estadoConexao, latenciaMs },
      });

      const body: TestarConexaoResult = {
        estadoConexao,
        latenciaMs,
        estado_conexao: estadoConexao,
        causa: null,
        mensagem: `conexao com o ${fonteRecord.nome} estabelecida com sucesso`,
        latencia_ms: latenciaMs,
      };
      return jsonResponse(body, 200);
    } catch (testErr) {
      if (testErr instanceof ConnectionTestError) {
        // Falha de teste: estado_conexao = erro, com a causa classificada.
        await updateFonteEstado(fonteRecord.id, "erro");
        await logSensitiveAction({
          tabela: "fontes",
          acao: "testar_conexao",
          registroId: fonteRecord.id,
          usuario: email,
          dadosNovos: {
            fonte: fonteRecord.tipo,
            resultado: "erro",
            causa: testErr.failureCause,
            latenciaMs: testErr.latenciaMs,
          },
        });

        // 200 com estado_conexao=erro: o teste executou e tem resultado util
        // (estado + causa + latencia); nao e erro de servidor.
        const body: TestarConexaoResult = {
          estadoConexao: "erro",
          latenciaMs: testErr.latenciaMs,
          estado_conexao: "erro",
          causa: testErr.failureCause,
          mensagem: messageForCause(testErr.failureCause, fonteRecord.nome),
          latencia_ms: testErr.latenciaMs,
        };
        return jsonResponse(body, 200);
      }
      throw testErr;
    }
  } catch (err) {
    return await errorResponse(err, { fn: "fontes-testar" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
