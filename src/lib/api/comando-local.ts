import { apiFetch } from "@/lib/api/client";

/**
 * Comandos que o cockpit pode enfileirar para o PC local executar (coleta Nomus
 * e extracao Tika/OCR, migradas para o PC pos-bloqueio do GitHub Actions). O PC
 * roda um servico de poll que pega o comando e dispara o wrapper .ps1.
 */
export type ComandoLocalTipo = "nomus-processos" | "nomus-pessoas" | "tika-ocr";

/** Ciclo de vida do comando na fila (espelha o check da tabela comando_local). */
export type ComandoLocalStatus = "pendente" | "executando" | "concluido" | "erro";

export interface ComandoLocal {
  id: string;
  comando: ComandoLocalTipo;
  status: ComandoLocalStatus;
  solicitadoPor: string | null;
  solicitadoEm: string;
  iniciadoEm: string | null;
  terminadoEm: string | null;
  resultado: string | null;
}

/** Forma crua devolvida pela Edge (snake_case do banco). */
interface ComandoLocalRaw {
  id: string;
  comando: ComandoLocalTipo;
  status: ComandoLocalStatus;
  solicitado_por: string | null;
  solicitado_em: string;
  iniciado_em: string | null;
  terminado_em: string | null;
  resultado: string | null;
}

function mapComando(raw: ComandoLocalRaw): ComandoLocal {
  return {
    id: raw.id,
    comando: raw.comando,
    status: raw.status,
    solicitadoPor: raw.solicitado_por,
    solicitadoEm: raw.solicitado_em,
    iniciadoEm: raw.iniciado_em,
    terminadoEm: raw.terminado_em,
    resultado: raw.resultado,
  };
}

/**
 * POST /comando-local-enfileirar — enfileira um comando para o PC local. A Edge
 * usa a sessao do cockpit (autorizacao) e barra duplicata (409) se o mesmo
 * comando ja estiver pendente ou em execucao. O PC o pega no proximo poll.
 */
export async function enfileirarComandoLocal(comando: ComandoLocalTipo): Promise<ComandoLocal> {
  const res = await apiFetch<{ comando: ComandoLocalRaw }>("comando-local-enfileirar", {
    method: "POST",
    body: JSON.stringify({ comando }),
  });
  return mapComando(res.comando);
}

/**
 * GET /comando-local-enfileirar — lista os comandos recentes para o cockpit
 * acompanhar o status (poll por react-query). Ordenado do mais recente.
 */
export async function listarComandosLocal(): Promise<ComandoLocal[]> {
  const res = await apiFetch<{ comandos: ComandoLocalRaw[] }>("comando-local-enfileirar", {
    method: "GET",
  });
  return (res.comandos ?? []).map(mapComando);
}
