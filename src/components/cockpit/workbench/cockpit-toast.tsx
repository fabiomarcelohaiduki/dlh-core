"use client";

// =====================================================================
// CockpitToast — toast canto-inferior-direito compartilhado das views do
// workbench. Centraliza o markup antes duplicado (WorkbenchTemplate e
// ColetaClient) e permite empilhar via `className` quando duas views podem
// emitir um toast ao mesmo tempo (ex.: erro de layout + aviso "apenas leitura").
//
//   - ok   = sucesso (verde)
//   - err  = falha (vermelho)
//   - info = aviso neutro (ex.: "Apenas leitura")
// =====================================================================

import { Check, Info, TriangleAlert } from "lucide-react";

export type ToastKind = "ok" | "err" | "info";

const TONE: Record<ToastKind, { box: string; Icon: typeof Check; iconClass: string }> = {
  ok: { box: "border-ok bg-ok-bg text-ok", Icon: Check, iconClass: "" },
  err: { box: "border-err bg-err-bg text-err", Icon: TriangleAlert, iconClass: "" },
  info: {
    box: "border-border bg-surface text-fg",
    Icon: Info,
    iconClass: "text-accent-strong",
  },
};

export function CockpitToast({
  kind,
  message,
  className = "bottom-6",
}: {
  kind: ToastKind;
  message: string;
  /** Posicao vertical (default bottom-6); use outra para empilhar. */
  className?: string;
}) {
  const { box, Icon, iconClass } = TONE[kind];
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed right-6 z-50 inline-flex items-center gap-2 rounded-md border px-3.5 py-2.5 text-[13px] shadow-[var(--shadow-overlay)] ${box} ${className}`}
    >
      <Icon aria-hidden="true" className={`size-4 ${iconClass}`} />
      {message}
    </div>
  );
}
