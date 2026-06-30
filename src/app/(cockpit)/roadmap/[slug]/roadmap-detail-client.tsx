"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { RoadmapStatusEmoji } from "@/lib/roadmap";

/**
 * RoadmapDetailClient — header + ações do detalhe de um item do roadmap.
 *
 * O conteúdo markdown é renderizado pelo parent (server component) e passado
 * como children. Aqui ficam só o breadcrumb, o status, o botão "voltar" e o
 * botão "abrir no editor" (link direto pro arquivo no filesystem).
 */

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

type Props = {
  slug: string;
  title: string;
  statusEmoji: RoadmapStatusEmoji;
  statusLabel: string;
  statusDate: string | null;
  atualizadoEm: string;
  children: React.ReactNode;
};

export function RoadmapDetailClient({
  slug,
  title,
  statusEmoji,
  statusLabel,
  statusDate,
  atualizadoEm,
  children,
}: Props) {
  const [copied, setCopied] = useState(false);

  async function copiarCaminho() {
    const caminho = `docs/roadmap/${slug}.md`;
    try {
      await navigator.clipboard.writeText(caminho);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard bloqueado: silencioso
    }
  }

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <p className="roadmap-crumb">
            <Link href="/roadmap">Roadmap</Link>
            <span aria-hidden="true">›</span>
            <code>{slug}</code>
          </p>
          <h2>
            <span className="roadmap-item-emoji" aria-hidden="true">
              {statusEmoji}
            </span>{" "}
            {title}
          </h2>
          <p className="roadmap-status-line">
            {statusLabel}
            {statusDate ? <span> · {formatarData(statusDate)}</span> : null}
            <span className="roadmap-status-mtime"> · MD atualizado {formatarMtime(atualizadoEm)}</span>
          </p>
        </div>
        <div className="page-head-actions">
          <button
            type="button"
            onClick={copiarCaminho}
            className="btn btn-sm"
            title="Copia o caminho do MD pra abrir no editor"
          >
            {copied ? "Copiado!" : "Copiar caminho do MD"}
          </button>
          <Link href="/roadmap" className="btn btn-sm">
            ← Índice
          </Link>
        </div>
      </div>

      <div className={cn("roadmap-content")}>{children}</div>
    </section>
  );
}
