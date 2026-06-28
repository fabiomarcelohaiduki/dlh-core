"use client";

import { useState } from "react";
import { Loader2, Play, TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/cockpit/status-pill";
import type { PillState } from "@/lib/status";
import { useComandosLocal, useEnfileirarComandoLocal } from "@/hooks/use-comando-local";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ComandoLocal, ComandoLocalStatus, ComandoLocalTipo } from "@/lib/api/comando-local";

/**
 * cmp-comando-local-disparo — botao de DISPARO de uma tarefa que roda no PC do
 * Fabio (coleta Nomus, extracao Tika/OCR), migradas para fora do GitHub Actions.
 *
 * O cockpit nao executa nada local: enfileira um comando (useEnfileirarComandoLocal)
 * que o servico de poll do PC pega e roda. O status volta pelo poll
 * (useComandosLocal) — esta UI so reflete o ciclo pendente -> executando ->
 * concluido | erro do comando mais recente desse tipo, sem inventar progresso.
 */

/** Texto humano de cada status na fila. */
const STATUS_LABEL: Record<ComandoLocalStatus, string> = {
  pendente: "Na fila",
  executando: "Executando",
  concluido: "Concluído",
  erro: "Falhou",
};

/** Mapeia o status da fila para o estado visual do StatusPill. */
function pillState(status: ComandoLocalStatus): PillState {
  switch (status) {
    case "pendente":
      return "warn";
    case "executando":
      return "run";
    case "concluido":
      return "ok";
    case "erro":
      return "err";
  }
}

/** Comando ativo = ainda nao selado (o PC ainda nao terminou). */
function ehAtivo(c: ComandoLocal | undefined): boolean {
  return c?.status === "pendente" || c?.status === "executando";
}

/** Carimbo humano do ultimo evento do comando (terminado, ou solicitado). */
function quando(c: ComandoLocal): string | null {
  const iso = c.terminadoEm ?? c.iniciadoEm ?? c.solicitadoEm;
  if (!iso) return null;
  return new Date(iso).toLocaleString("pt-BR");
}

export function ComandoLocalDisparo({
  comando,
  rotulo,
}: {
  comando: ComandoLocalTipo;
  /** Acao no botao (ex.: "Coletar processos", "Extrair anexos"). */
  rotulo: string;
}) {
  const lista = useComandosLocal();
  const enfileirar = useEnfileirarComandoLocal();
  const [erro, setErro] = useState<string | null>(null);

  // Comando mais recente DESTE tipo (a lista ja vem ordenada por recencia).
  const atual = lista.data?.find((c) => c.comando === comando);
  const ativo = ehAtivo(atual);
  const disparando = enfileirar.isPending || ativo;

  async function handleDisparar() {
    if (disparando) return;
    setErro(null);
    try {
      await enfileirar.mutateAsync(comando);
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? "Esse comando já está na fila ou em execução."
          : "Não foi possível enfileirar o comando. Tente novamente.";
      setErro(message);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => void handleDisparar()}
          disabled={disparando}
          title={ativo ? "Aguarde o PC terminar a execução atual" : rotulo}
        >
          {disparando ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
          <span>{ativo ? "Em execução…" : rotulo}</span>
        </button>

        {atual && (
          <StatusPill state={pillState(atual.status)} label={STATUS_LABEL[atual.status]} />
        )}
      </div>

      {atual && quando(atual) && (
        <small className="muted">
          {atual.status === "concluido" || atual.status === "erro" ? "Última execução" : "Solicitado"}
          {": "}
          {quando(atual)}
          {atual.solicitadoPor ? ` · ${atual.solicitadoPor}` : ""}
        </small>
      )}

      {atual?.resultado && (
        <pre
          className="card"
          style={{
            margin: 0,
            padding: 10,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {atual.resultado}
        </pre>
      )}

      {erro && (
        <span className={cn("save-note", "err")}>
          <TriangleAlert aria-hidden="true" />
          {erro}
        </span>
      )}
    </div>
  );
}
