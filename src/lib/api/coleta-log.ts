import { apiFetch, buildQuery } from "@/lib/api/client";

/**
 * Console ao vivo da guia "Logs" do submodulo Coleta: cada linha de coleta_log
 * e uma linha de terminal (item-a-item). A carga inicial vem desta Edge; o
 * stream chega depois pelo Supabase Realtime (hook use-coleta-log).
 */
export type ColetaLogOrigem = "effecti" | "nomus" | "gmail" | "drive" | "tika" | "sistema";
export type ColetaLogNivel = "info" | "warn" | "erro";

export interface ColetaLogLinha {
  id: number;
  execucaoId: string | null;
  comandoId: string | null;
  origem: ColetaLogOrigem;
  nivel: ColetaLogNivel;
  mensagem: string;
  criadoEm: string;
}

/** Forma crua devolvida pela Edge (snake_case do banco). */
interface ColetaLogLinhaRaw {
  id: number;
  execucao_id: string | null;
  comando_id: string | null;
  origem: ColetaLogOrigem;
  nivel: ColetaLogNivel;
  mensagem: string;
  criado_em: string;
}

export function mapColetaLogLinha(raw: ColetaLogLinhaRaw): ColetaLogLinha {
  return {
    id: raw.id,
    execucaoId: raw.execucao_id,
    comandoId: raw.comando_id,
    origem: raw.origem,
    nivel: raw.nivel,
    mensagem: raw.mensagem,
    criadoEm: raw.criado_em,
  };
}

export interface ListarColetaLogInput {
  /** Quantas linhas trazer na carga inicial (default Edge 300, teto 1000). */
  limite?: number;
  /** Filtra por fonte; ausente = todas. */
  origem?: ColetaLogOrigem;
}

/**
 * GET /coleta-log — ultimas N linhas em ordem cronologica (id asc), para o
 * console renderizar de cima para baixo. O stream ao vivo vem do Realtime.
 */
export async function listarColetaLog(input: ListarColetaLogInput = {}): Promise<ColetaLogLinha[]> {
  const query = buildQuery({ limite: input.limite, origem: input.origem });
  const res = await apiFetch<{ linhas: ColetaLogLinhaRaw[] }>(`coleta-log${query}`, { method: "GET" });
  return (res.linhas ?? []).map(mapColetaLogLinha);
}
