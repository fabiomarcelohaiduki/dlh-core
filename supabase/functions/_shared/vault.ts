// =====================================================================
// _shared/vault.ts
// Acesso a credenciais via Supabase Vault (RNF-02). Encapsula as RPCs
// SECURITY DEFINER (public.set_fonte_secret / public.get_fonte_secret)
// chamadas exclusivamente com o cliente service_role (server-side).
//
// O segredo NUNCA e lido de .env em producao nem retornado ao cliente:
//   - setFonteSecret(): grava/atualiza o token no Vault; fontes.token_cifrado
//     guarda apenas a referencia.
//   - getFonteSecret(): le o segredo decifrado em runtime para uso imediato
//     (ex.: teste de conexao / coleta), sem persistir em lugar nenhum.
//   - getEffectiFonte(): resolve a fonte Effecti (id, endpoint_base, estado)
//     usada pelos endpoints de credencial/teste e pelo conector.
// =====================================================================

import { createServiceClient } from "./supabase.ts";
import { HttpError } from "./http.ts";

/** Tipo da fonte Effecti no MVP (extensivel a novos conectores - RF-11). */
export const EFFECTI_TIPO = "effecti" as const;

/**
 * Nome deterministico do segredo da API key de servico read-only da Lia no
 * Vault (RNF-01). Distinto da service_role e da sessao humana; rotacionavel
 * e revogavel via as RPCs abaixo (set/revoke), todas server-side only.
 */
export const LIA_SERVICE_KEY_NAME = "LIA_SERVICE_API_KEY" as const;

/**
 * Nome deterministico do segredo da API key da LLM (OpenAI) no Vault,
 * usado pelas geracoes assistidas do cockpit. Configurado pela tela de
 * "Configuracoes da empresa" (card de IA); server-side only, nunca volta
 * ao cliente.
 */
export const LLM_OPENAI_API_KEY_NAME = "LLM_OPENAI_API_KEY" as const;

export interface FonteRecord {
  id: string;
  nome: string;
  tipo: string;
  endpointBase: string;
  estadoConexao: "conectada" | "erro" | "nao_configurada";
  /** true quando ha referencia de credencial gravada (token_cifrado != null). */
  temCredencial: boolean;
  /** Timestamp ISO da ultima coleta concluida (fontes.ultima_coleta_em); null se nunca coletou. */
  ultimaColetaEm: string | null;
}

interface FonteRow {
  id: string;
  nome: string;
  tipo: string;
  endpoint_base: string;
  estado_conexao: string;
  token_cifrado: string | null;
  ultima_coleta_em: string | null;
}

/**
 * Resolve a fonte de um dado tipo (default: Effecti) via service_role.
 * Lanca 404 quando a fonte nao existe (substrato precisa do seed da sprint-001).
 */
export async function getFonteByTipo(tipo: string = EFFECTI_TIPO): Promise<FonteRecord> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("fontes")
    .select("id, nome, tipo, endpoint_base, estado_conexao, token_cifrado, ultima_coleta_em")
    .eq("tipo", tipo)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "fonte_query_failed", "falha ao consultar a fonte");
  }
  if (!data) {
    throw new HttpError(404, "fonte_nao_encontrada", `fonte do tipo '${tipo}' nao encontrada`);
  }

  const row = data as FonteRow;
  return {
    id: row.id,
    nome: row.nome,
    tipo: row.tipo,
    endpointBase: row.endpoint_base,
    estadoConexao: normalizeEstado(row.estado_conexao),
    temCredencial: row.token_cifrado != null && row.token_cifrado.trim() !== "",
    ultimaColetaEm: row.ultima_coleta_em ?? null,
  };
}

function normalizeEstado(value: string): FonteRecord["estadoConexao"] {
  if (value === "conectada" || value === "erro" || value === "nao_configurada") return value;
  return "nao_configurada";
}

/**
 * Grava/atualiza o segredo da fonte no Vault e a referencia em token_cifrado.
 * Server-side apenas. Retorna sempre true em sucesso; erros viram HttpError.
 */
export async function setFonteSecret(fonteId: string, secret: string): Promise<boolean> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("set_fonte_secret", {
    p_fonte_id: fonteId,
    p_secret: secret,
  });

  if (error) {
    throw new HttpError(500, "vault_write_failed", "falha ao gravar a credencial no Vault");
  }
  return data === true;
}

/**
 * Le o segredo decifrado da fonte em runtime (nunca persistido/retornado ao
 * cliente). Retorna null quando a credencial ainda nao foi configurada.
 */
export async function getFonteSecret(fonteId: string): Promise<string | null> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("get_fonte_secret", {
    p_fonte_id: fonteId,
  });

  if (error) {
    throw new HttpError(500, "vault_read_failed", "falha ao ler a credencial do Vault");
  }
  const secret = typeof data === "string" ? data : null;
  return secret && secret.trim() !== "" ? secret : null;
}

// ---------------------------------------------------------------------
// Segredos de servico (ex.: API key da Lia) no Vault — server-side only.
// ---------------------------------------------------------------------

/**
 * Grava/rotaciona um segredo de servico no Vault pelo nome deterministico.
 * Regravar o mesmo nome troca a chave em uso (rotacao, RNF-01). Server-side
 * apenas. Retorna true em sucesso; erros viram HttpError.
 */
export async function setServiceSecret(name: string, secret: string): Promise<boolean> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("set_service_secret", {
    p_name: name,
    p_secret: secret,
  });

  if (error) {
    throw new HttpError(500, "vault_write_failed", "falha ao gravar o segredo de servico no Vault");
  }
  return data === true;
}

/**
 * Le o segredo de servico decifrado em runtime pelo nome (nunca retornado ao
 * cliente). Retorna null quando o segredo ainda nao foi emitido/foi revogado.
 */
export async function getServiceSecret(name: string): Promise<string | null> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("get_service_secret", {
    p_name: name,
  });

  if (error) {
    throw new HttpError(500, "vault_read_failed", "falha ao ler o segredo de servico do Vault");
  }
  const secret = typeof data === "string" ? data : null;
  return secret && secret.trim() !== "" ? secret : null;
}

/**
 * Revoga (remove) um segredo de servico do Vault pelo nome. Apos revogar,
 * chamadas com a chave antiga deixam de autenticar (RNF-01). Retorna true
 * quando havia segredo removido; false quando nao existia.
 */
export async function revokeServiceSecret(name: string): Promise<boolean> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("revoke_service_secret", {
    p_name: name,
  });

  if (error) {
    throw new HttpError(
      500,
      "vault_revoke_failed",
      "falha ao revogar o segredo de servico no Vault",
    );
  }
  return data === true;
}

/**
 * Atualiza o estado_conexao da fonte (conectada/erro/nao_configurada) via
 * service_role. O update dispara os triggers de auditoria e updated_at.
 */
export async function updateFonteEstado(
  fonteId: string,
  estado: FonteRecord["estadoConexao"],
): Promise<void> {
  const service = createServiceClient();
  const { error } = await service
    .from("fontes")
    .update({ estado_conexao: estado })
    .eq("id", fonteId);

  if (error) {
    throw new HttpError(500, "fonte_update_failed", "falha ao atualizar o estado da conexao");
  }
}
