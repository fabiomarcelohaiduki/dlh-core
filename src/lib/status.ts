import type { Execucao, EstadoConexao, StatusIngestao } from "@/lib/api/types";

/**
 * Estados travados do Design Lock (convencao unica do projeto):
 *  ok   = sucesso / Saudavel
 *  run  = em andamento / processing
 *  warn = atencao / erros parciais
 *  err  = falha
 *  idle = nao configurado
 *
 * O mapeamento estado -> token de cor vive em cmp-status-pill (status-pill.tsx),
 * unica fonte de verdade visual. Aqui derivamos apenas o estado + rotulo a
 * partir dos enums de dominio do backend.
 */
export type PillState = "ok" | "run" | "warn" | "err" | "idle";

export interface PillDescriptor {
  state: PillState;
  label: string;
}

/** Healthcheck: distingue warn (degradado) de err (parado). */
export function healthDescriptor(status: StatusIngestao): PillDescriptor {
  switch (status) {
    case "Saudavel":
      return { state: "ok", label: "Operacional" };
    case "Atencao":
      return { state: "warn", label: "Atenção" };
    case "Falha":
      return { state: "err", label: "Falha" };
    default:
      return { state: "idle", label: "Não configurado" };
  }
}

/** Texto auxiliar do card de healthcheck por estado. */
export function healthMeta(status: StatusIngestao): { tone: "up" | "warn" | "err"; text: string } {
  switch (status) {
    case "Saudavel":
      return { tone: "up", text: "Pipeline coleta → tratamento → indexação" };
    case "Atencao":
      return { tone: "warn", text: "Pipeline degradado · erros parciais na ingestão" };
    case "Falha":
    default:
      return { tone: "err", text: "Pipeline parado · intervenção necessária" };
  }
}

/**
 * Execucao: deriva o pill a partir de `status` (e contagens). Concluida sem
 * novos vira warn ("sem novos"), preservando a semantica do artifact.
 */
export function execucaoDescriptor(execucao: Execucao): PillDescriptor {
  switch (execucao.status) {
    case "em_andamento":
      return { state: "run", label: "Em andamento" };
    case "erro":
      return { state: "err", label: "Com erro" };
    case "concluida":
      if (execucao.novos === 0 && execucao.alterados === 0) {
        return { state: "warn", label: "Concluída · sem novos" };
      }
      return { state: "ok", label: "Concluída" };
    default:
      return { state: "idle", label: execucao.status || "—" };
  }
}

/**
 * Origem normalizada das telas multi-origem (filtro Effecti x Nomus).
 *  - execucoes.origem  = tipo da fonte ('effecti' | 'nomus'); null (legado) = Effecti.
 *  - erros.origem      = 'aviso' (Effecti) ou 'processo-*' (Nomus).
 */
export type OrigemKey = "effecti" | "nomus";

/**
 * Teto de retomadas automaticas (NOMUS_MAX_RETOMADAS). Acima dele a retomada
 * passa a exigir acao manual ('Retomar'). Espelha o default do backend
 * (_shared/nomus-pipeline.ts: nomusMaxRetomadas()).
 */
export const NOMUS_MAX_RETOMADAS = 3;

/** Normaliza a origem crua (fonte/origem do erro) para a chave do filtro. */
export function normalizeOrigem(origem: string | null | undefined): OrigemKey {
  if (!origem) return "effecti";
  const o = origem.toLowerCase();
  if (o === "effecti" || o === "aviso") return "effecti";
  if (o === "nomus" || o.startsWith("processo")) return "nomus";
  return "effecti";
}

/** Rotulo curto da origem para badges/filtros. */
export function origemLabel(key: OrigemKey): string {
  return key === "nomus" ? "Nomus" : "Effecti";
}

/**
 * True quando a execucao em erro esgotou as retomadas automaticas e aguarda
 * acao manual ('Retomar'): so vale para fontes em blocos (Nomus, com cursor).
 */
export function precisaRetomadaManual(execucao: Execucao): boolean {
  if (execucao.status !== "erro") return false;
  const cp = execucao.checkpoint;
  if (!cp || cp.fase === "concluido") return false;
  return (cp.tentativasRetomada ?? 0) >= NOMUS_MAX_RETOMADAS;
}

/** Severidade do erro -> pill. */
export function severidadeDescriptor(severidade: string): PillDescriptor {
  switch (severidade.toLowerCase()) {
    case "alta":
      return { state: "err", label: "Alta" };
    case "media":
    case "média":
      return { state: "warn", label: "Média" };
    case "baixa":
    default:
      return { state: "idle", label: "Baixa" };
  }
}

/** Status de indexacao do aviso (avisos.status_indexacao) -> pill do edital. */
export function indexacaoDescriptor(status: string | null): PillDescriptor {
  switch (status) {
    case "indexado":
      return { state: "ok", label: "Indexado" };
    case "em_andamento":
      return { state: "run", label: "Indexando" };
    case "erro":
      return { state: "err", label: "Falha de indexação" };
    default:
      return { state: "idle", label: "Não indexado" };
  }
}

/**
 * True quando ha uma coleta em andamento PARA A FONTE informada (base do
 * anti-duplo-disparo). Filtra por `fonteId` — a chave inequivoca do lock
 * (o backend tranca por fonte_id). NAO usa `execucoes.origem`: na pratica
 * nenhuma fonte popula essa coluna (fica null tanto no Effecti quanto no
 * Nomus), entao comparar por origem dava falso negativo (Nomus nao travava)
 * e falso positivo (coleta do Nomus travava o botao do Effecti). Sem fonteId
 * (ainda hidratando) nao trava nada.
 */
export function hasRunningExecucao(
  items: Execucao[] | undefined,
  fonteId: string | null | undefined,
): boolean {
  if (!fonteId) return false;
  return Boolean(
    items?.some((e) => e.status === "em_andamento" && e.fonteId === fonteId),
  );
}

/**
 * Estado de conexao da fonte (fontes.estado_conexao) -> pill do cmp-cred-form.
 * nao_configurada cai em `idle` (liga-se ao onboarding e ao estado vazio).
 */
export function conexaoDescriptor(estado: EstadoConexao): PillDescriptor {
  switch (estado) {
    case "conectada":
      return { state: "ok", label: "Conectada" };
    case "erro":
      return { state: "err", label: "Erro de conexão" };
    default:
      return { state: "idle", label: "Não configurada" };
  }
}

/** Estado de conexao por fonte para o indicador global do topbar. */
export interface FonteConexao {
  tipo: "effecti" | "nomus" | "drive" | "gmail";
  label: string;
  state: PillState;
}

/**
 * Cor da conexao no topbar. 'erro' explicito vence (vermelho); fonte conectada
 * — credencial presente (Effecti/Nomus) ou conta OAuth ligada (Drive/Gmail) —
 * fica verde; sem configuracao cai em cinza. Espelha a semantica do antigo
 * "Effecti · conectado" (configurada = conectada).
 */
export function conexaoFonteState(estado: string | null, conectado: boolean): PillState {
  if (estado === "erro") return "err";
  if (conectado) return "ok";
  return "idle";
}
