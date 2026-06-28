// =====================================================================
// _shared/coleta-log.ts
// Logger de stream para a tabela coleta_log: as linhas que a coleta ja imprime
// em console.log passam a TAMBEM ir para o banco, alimentando o console ao vivo
// da guia "Logs" do submodulo Coleta (decisao Fabio 2026-06-28).
//
// PROBLEMA QUE RESOLVE: a granularidade e item-a-item (centenas/milhares de
// linhas por coleta grande). Um INSERT por linha = round-trips demais no loop
// de background da Edge. Este logger BUFFERIZA as linhas e descarrega em LOTE
// (por tamanho ou por tempo), entao o Realtime entrega cada linha (um evento
// INSERT por linha do lote) sem afogar a Edge em chamadas.
//
// BEST-EFFORT: o log nunca derruba a coleta. Falha de gravacao vai para
// console.error e a coleta segue (o stream e observabilidade, nao dado critico).
//
// USO (dentro do loop de background, depois de abrir a execucao):
//   const log = createColetaLogger(db, { execucaoId, origem: "gmail" });
//   log.info(`[mensagem ${i}/${n}] ${id}: ${k} item(ns)`);
//   log.warn("..."); log.erro("...");
//   await log.flush();   // no fim do loop (e antes de fechar a execucao)
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";

/** Fonte da linha (casa o check de coleta_log.origem). */
export type ColetaLogOrigem = "effecti" | "nomus" | "gmail" | "drive" | "tika" | "sistema";

/** Nivel da linha (cor no console; 'erro' tambem entra na tela de Erros). */
export type ColetaLogNivel = "info" | "warn" | "erro";

interface ColetaLoggerOpts {
  /** Execucao da Edge a que a linha pertence (null para as origens do PC). */
  execucaoId?: string | null;
  /** Comando do PC a que a linha pertence (null para as origens da Edge). */
  comandoId?: string | null;
  origem: ColetaLogOrigem;
}

interface LinhaPendente {
  execucao_id: string | null;
  comando_id: string | null;
  origem: ColetaLogOrigem;
  nivel: ColetaLogNivel;
  mensagem: string;
  criado_em: string;
}

// Descarrega quando o buffer atinge este tamanho (lote de INSERT) ...
const FLUSH_TAMANHO = 25;
// ... ou apos este tempo desde a primeira linha pendente (mantem o console
// "ao vivo" mesmo em coleta lenta, sem esperar encher o lote).
const FLUSH_DEBOUNCE_MS = 600;
// Teto por linha (a coluna e text, mas linha de console nao precisa de payload).
const MSG_MAX = 2000;

export interface ColetaLogger {
  info(mensagem: string): void;
  warn(mensagem: string): void;
  erro(mensagem: string): void;
  /** Descarrega o que estiver pendente. Chamar no fim do loop. */
  flush(): Promise<void>;
}

/**
 * Cria um logger vinculado a uma coleta. As escritas sao agrupadas e enviadas
 * em lote; o chamador so empilha linhas e da um flush() ao final.
 */
export function createColetaLogger(db: SupabaseClient, opts: ColetaLoggerOpts): ColetaLogger {
  const buffer: LinhaPendente[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Encadeia os flushes para nunca rodar dois INSERT concorrentes do mesmo
  // logger (preserva a ordem das linhas no banco).
  let cadeia: Promise<void> = Promise.resolve();

  function agendarFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  function push(nivel: ColetaLogNivel, mensagem: string): void {
    buffer.push({
      execucao_id: opts.execucaoId ?? null,
      comando_id: opts.comandoId ?? null,
      origem: opts.origem,
      nivel,
      mensagem: mensagem.length > MSG_MAX ? mensagem.slice(0, MSG_MAX) : mensagem,
      criado_em: new Date().toISOString(),
    });
    if (buffer.length >= FLUSH_TAMANHO) void flush();
    else agendarFlush();
  }

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return cadeia;
    const lote = buffer.splice(0, buffer.length);
    cadeia = cadeia.then(async () => {
      const { error } = await db.from("coleta_log").insert(lote);
      if (error) {
        console.error("[coleta-log] falha ao gravar lote de log", {
          origem: opts.origem,
          linhas: lote.length,
          error: error.message,
        });
      }
    });
    return cadeia;
  }

  return {
    info: (m) => push("info", m),
    warn: (m) => push("warn", m),
    erro: (m) => push("erro", m),
    flush,
  };
}
