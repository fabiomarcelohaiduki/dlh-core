"use client";

// =====================================================================
// LogsConsole — console ao vivo da guia "Logs" do submodulo Coleta.
//
// Mostra, em estilo terminal (linha-a-linha, item-a-item), o que cada fonte
// de coleta esta fazendo AGORA. A carga inicial vem da Edge coleta-log e o
// stream chega pelo Supabase Realtime (hook useColetaLog). E uma "janela do
// agora", nao historico: o banco retem 48h e o cliente mantem ~1000 linhas.
//
// Filtro por fonte (segmented), indicador de tempo real, contagem de linhas e
// botao de limpar a visao local. Auto-scroll que respeita a leitura do usuario:
// so cola no fim se ele ja estava no fim (senao mostra "novas linhas abaixo").
// =====================================================================

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useColetaLog } from "@/hooks/use-coleta-log";
import type { ColetaLogNivel, ColetaLogOrigem } from "@/lib/api/coleta-log";

type FonteLog = "todas" | ColetaLogOrigem;

const FONTES_LOG: { value: FonteLog; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "effecti", label: "Effecti" },
  { value: "nomus", label: "Nomus" },
  { value: "gmail", label: "Gmail" },
  { value: "drive", label: "Drive" },
  { value: "tika", label: "Tika/OCR" },
  { value: "sistema", label: "Sistema" },
];

const ORIGEM_LABEL: Record<ColetaLogOrigem, string> = {
  effecti: "EFFECTI",
  nomus: "NOMUS",
  gmail: "GMAIL",
  drive: "DRIVE",
  tika: "TIKA",
  sistema: "SISTEMA",
};

// Cor da linha pelo nivel (tokens do design system, sem hex).
const NIVEL_CLASS: Record<ColetaLogNivel, string> = {
  info: "text-soft",
  warn: "text-warn",
  erro: "text-err",
};

/** HH:MM:SS local (Brasilia) — o console e janela do agora, dia implicito. */
function horaLinha(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour12: false });
}

export function LogsConsole() {
  const [fonte, setFonte] = useState<FonteLog>("todas");
  const origem = fonte === "todas" ? undefined : fonte;
  const { linhas, connected, carregando, limpar } = useColetaLog(origem);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Cola no fim por padrao; desativa quando o usuario rola para cima e reativa
  // quando ele volta ao fim. Evita "puxar" a leitura quando chega linha nova.
  const [presoNoFim, setPresoNoFim] = useState(true);
  const [temNovas, setTemNovas] = useState(false);

  function aoRolar() {
    const el = scrollRef.current;
    if (!el) return;
    const noFim = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setPresoNoFim(noFim);
    if (noFim) setTemNovas(false);
  }

  // Apos cada render com linhas novas, cola no fim se o usuario estava no fim;
  // senao sinaliza que ha novas linhas abaixo. useLayoutEffect evita flicker.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (presoNoFim) el.scrollTop = el.scrollHeight;
    else setTemNovas(true);
  }, [linhas, presoNoFim]);

  function irParaOFim() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPresoNoFim(true);
    setTemNovas(false);
  }

  // Reset do "preso no fim" ao trocar de fonte (recomeca colado no fim).
  useEffect(() => {
    setPresoNoFim(true);
    setTemNovas(false);
  }, [fonte]);

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar: filtro de fonte + estado + acoes */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filtrar console por fonte" className="flex flex-wrap gap-1">
          {FONTES_LOG.map((f) => {
            const active = f.value === fonte;
            return (
              <button
                key={f.value}
                type="button"
                aria-pressed={active}
                onClick={() => setFonte(f.value)}
                className={cn(
                  "rounded-[7px] border px-2.5 py-1 text-[12px] font-semibold transition-colors",
                  active
                    ? "border-accent-line bg-accent-soft text-accent-strong"
                    : "border-border bg-surface text-muted hover:text-fg",
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <span className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-muted">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 rounded-full",
              connected ? "animate-pulse bg-ok" : "bg-warn",
            )}
          />
          {connected ? "Tempo real ativo" : "Reconectando…"}
        </span>
        <span className="text-[12px] tabular-nums text-soft">{linhas.length} linhas</span>
        <button
          type="button"
          onClick={limpar}
          title="Limpar o console (apenas a visão; não apaga o banco)"
          aria-label="Limpar o console"
          className="inline-flex size-7 items-center justify-center rounded-[7px] border border-border bg-surface text-muted transition-colors hover:text-fg"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Console */}
      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={aoRolar}
          role="log"
          aria-live="polite"
          aria-label="Console de coleta ao vivo"
          className="h-[60vh] min-h-[320px] overflow-auto rounded-[10px] border border-border bg-surface-2 p-3 font-mono text-[12.5px] leading-[1.55]"
        >
          {carregando ? (
            <p className="text-muted">Carregando console…</p>
          ) : linhas.length === 0 ? (
            <p className="text-muted">
              Sem linhas {fonte === "todas" ? "ainda" : `para ${ORIGEM_LABEL[fonte as ColetaLogOrigem]}`}.
              As linhas aparecem aqui em tempo real durante a coleta.
            </p>
          ) : (
            linhas.map((l) => (
              <div key={l.id} className="flex gap-2 whitespace-pre-wrap break-words">
                <span className="shrink-0 select-none text-faint tabular-nums">{horaLinha(l.criadoEm)}</span>
                <span className="shrink-0 select-none text-[11px] font-semibold text-accent-strong">
                  {ORIGEM_LABEL[l.origem]}
                </span>
                <span className={cn("min-w-0 flex-1", NIVEL_CLASS[l.nivel])}>{l.mensagem}</span>
              </div>
            ))
          )}
        </div>

        {temNovas ? (
          <button
            type="button"
            onClick={irParaOFim}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent-line bg-surface px-3 py-1 text-[12px] font-semibold text-accent-strong shadow-md"
          >
            <ArrowDown className="size-3.5" aria-hidden="true" />
            Novas linhas
          </button>
        ) : null}
      </div>
    </div>
  );
}
