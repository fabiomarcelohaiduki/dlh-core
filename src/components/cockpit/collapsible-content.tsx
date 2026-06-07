"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { formatNumber } from "@/lib/format";

/** Acima deste tamanho, o conteudo expandido e materializado em lotes. */
const INCREMENTAL_THRESHOLD = 20_000;
/** Caracteres adicionados por frame durante a renderizacao incremental. */
const CHUNK = 20_000;

/**
 * CollapsibleContent — conteudo verbatim / payload bruto potencialmente muito
 * grande, colapsavel/expansivel. Quando expandido e acima do limite, o texto
 * e materializado em lotes por requestAnimationFrame, evitando travar a thread
 * principal ao injetar centenas de KB de uma vez (criterio US-14/US-19).
 */
export function CollapsibleContent({
  content,
  variant = "text",
  previewChars = 1_400,
  label = "conteúdo",
}: {
  content: string;
  variant?: "text" | "code";
  previewChars?: number;
  label?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(previewChars);
  const rafRef = useRef<number | null>(null);

  const total = content.length;
  const collapsible = total > previewChars;

  useEffect(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (!expanded) {
      setVisible(previewChars);
      return;
    }

    // Pequeno o suficiente: materializa de uma vez.
    if (total <= INCREMENTAL_THRESHOLD) {
      setVisible(total);
      return;
    }

    // Grande: revela em lotes para nao bloquear a UI.
    let current = Math.min(total, Math.max(previewChars, CHUNK));
    setVisible(current);

    const step = () => {
      current = Math.min(total, current + CHUNK);
      setVisible(current);
      if (current < total) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [expanded, total, previewChars]);

  const shown = expanded ? content.slice(0, visible) : content.slice(0, previewChars);
  const rendering = expanded && visible < total;

  if (total === 0) {
    return (
      <div className="empty" style={{ padding: "28px 20px" }}>
        <p>Sem {label} disponível para este aviso.</p>
      </div>
    );
  }

  return (
    <div>
      {variant === "code" ? (
        <pre className="code">{shown}</pre>
      ) : (
        <p className="verbatim">{shown}</p>
      )}

      {collapsible ? (
        <div className="collapse-foot">
          <button
            type="button"
            className="link"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <>
                Recolher
                <ChevronUp aria-hidden="true" />
              </>
            ) : (
              <>
                Expandir {label} completo
                <ChevronDown aria-hidden="true" />
              </>
            )}
          </button>
          {rendering ? (
            <span className="meta rendering" role="status">
              <Loader2 className="spin" aria-hidden="true" />
              Renderizando… {formatNumber(visible)} / {formatNumber(total)} caracteres
            </span>
          ) : (
            <span className="meta">{formatNumber(total)} caracteres</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
