"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { RoadmapItem, RoadmapStatusEmoji } from "@/lib/roadmap";

/**
 * RoadmapIndexClient — lista de itens do roadmap com filtro por status.
 *
 * Estado 100% client (filter + busca). Os items vêm do server (page.tsx lê o
 * filesystem). Recarregar a página puxa o filesystem de novo — não tem cache.
 */

type StatusFiltro = "todos" | RoadmapStatusEmoji;

const FILTROS: ReadonlyArray<{ value: StatusFiltro; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "🟡", label: "🟡 Ideia" },
  { value: "🔵", label: "🔵 Decidido" },
  { value: "🟢", label: "🟢 Em produção" },
  { value: "⚫", label: "⚫ Pausado" },
  { value: "✅", label: "✅ Concluído" },
];

const TOOLBAR_SEARCH_CLASS =
  "h-9 w-full sm:w-72 rounded-md border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-muted focus:border-amber focus:outline-none focus:ring-2 focus:ring-amber/30";

function formatarData(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatarMtime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RoadmapIndexClient({ items }: { items: RoadmapItem[] }) {
  const [filtro, setFiltro] = useState<StatusFiltro>("todos");
  const [busca, setBusca] = useState("");

  const contagemPorStatus = useMemo(() => {
    const m: Record<string, number> = { todos: items.length };
    for (const it of items) m[it.statusEmoji] = (m[it.statusEmoji] ?? 0) + 1;
    return m;
  }, [items]);

  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return items.filter((it) => {
      if (filtro !== "todos" && it.statusEmoji !== filtro) return false;
      if (termo && !`${it.title} ${it.summary}`.toLowerCase().includes(termo)) return false;
      return true;
    });
  }, [items, filtro, busca]);

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Roadmap</h2>
          <p>
            Índice provisório de decisões, ideias e pendências. Lido direto de{" "}
            <code>docs/roadmap/*.md</code> — edite o MD e dê refresh aqui.
          </p>
        </div>
      </div>

      <aside
        role="note"
        className="mb-4 rounded-md border border-amber/30 bg-amber/5 px-4 py-3 text-sm leading-relaxed text-fg-muted"
      >
        <strong className="font-semibold text-amber">📝 Esboço inicial.</strong>{" "}
        Este roadmap é o primeiro desenho do que cada feature vai virar —{" "}
        <strong className="font-semibold text-fg">não é a fonte da verdade</strong>.
        Quando a feature for criada via pipeline, o código e a SPEC passam a ser a fonte da verdade; este doc vira referência.
      </aside>

      <div className="filter-bar">
        <input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por título ou resumo…"
          aria-label="Buscar no roadmap"
          className={TOOLBAR_SEARCH_CLASS}
        />
        <div className="filter-group" role="group" aria-label="Filtrar por status" style={{ marginLeft: "auto" }}>
          {FILTROS.map((f) => {
            const active = filtro === f.value;
            const n = contagemPorStatus[f.value] ?? 0;
            return (
              <button
                key={f.value}
                type="button"
                className={cn("btn btn-sm", active && "btn-primary")}
                aria-pressed={active}
                onClick={() => setFiltro(f.value)}
              >
                {f.label}
                <span className="ml-1.5 text-xs opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {visiveis.length === 0 ? (
        <div className="empty-state">
          <p>Nenhum item pra esse filtro.</p>
        </div>
      ) : (
        <ul className="roadmap-list">
          {visiveis.map((it) => (
            <li key={it.slug} className="roadmap-item">
              <Link href={`/roadmap/${it.slug}`} className="roadmap-item-link">
                <div className="roadmap-item-head">
                  <span className="roadmap-item-emoji" aria-hidden="true">
                    {it.statusEmoji}
                  </span>
                  <h3 className="roadmap-item-title">{it.title}</h3>
                  <span className="roadmap-item-meta">
                    {it.statusDate ? formatarData(it.statusDate) : "—"}
                  </span>
                </div>
                {it.summary && <p className="roadmap-item-summary">{it.summary}</p>}
                <p className="roadmap-item-foot">
                  <code>{it.slug}</code>
                  <span aria-hidden="true">·</span>
                  <span>atualizado {formatarMtime(it.atualizadoEm)}</span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
