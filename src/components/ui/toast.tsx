"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Toast composto do design system (D-FE-04).
 *
 * Espelha o `.toast` do artifact (canto inferior direito, surface-2 +
 * border-strong + shadow-overlay). Suporta fila/empilhamento basico: varios
 * toasts coexistem numa coluna, cada um com auto-dismiss. Sem hex hardcoded.
 *
 * Uso: envolva a arvore com <ToastProvider> e dispare via useToast():
 *   const { toast } = useToast();
 *   toast({ title: "Salvo", variant: "ok" });
 *
 * Acessibilidade: a regiao usa `aria-live="polite"`; cada toast e
 * `role="status"` (ok/info) ou `role="alert"` (warn/danger).
 */

export type ToastVariant = "ok" | "warn" | "danger" | "info";

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Duracao em ms antes do auto-dismiss. Padrao: 4000. 0 = persistente. */
  duration?: number;
}

interface ToastEntry extends Required<Omit<ToastOptions, "description">> {
  id: string;
  description?: string;
  leaving: boolean;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast deve ser usado dentro de <ToastProvider>.");
  }
  return ctx;
}

const variantIcon: Record<ToastVariant, LucideIcon> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  danger: XCircle,
  info: Info,
};

const variantIconClass: Record<ToastVariant, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-err",
  info: "text-muted",
};

const EXIT_MS = 180;

export function ToastProvider({
  children,
  max = 4,
}: {
  children: React.ReactNode;
  max?: number;
}) {
  const [toasts, setToasts] = React.useState<ToastEntry[]>([]);
  const [mounted, setMounted] = React.useState(false);
  const timers = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  React.useEffect(() => setMounted(true), []);

  React.useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const remove = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = React.useCallback(
    (id: string) => {
      // Marca como saindo para animar antes de remover de fato.
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
      );
      const timer = setTimeout(() => remove(id), EXIT_MS);
      timers.current.set(`${id}-exit`, timer);
    },
    [remove],
  );

  const toast = React.useCallback(
    (options: ToastOptions) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const entry: ToastEntry = {
        id,
        title: options.title,
        description: options.description,
        variant: options.variant ?? "info",
        duration: options.duration ?? 4000,
        leaving: false,
      };
      setToasts((prev) => {
        const next = [...prev, entry];
        // Empilhamento basico: mantem no maximo `max` toasts visiveis.
        return next.length > max ? next.slice(next.length - max) : next;
      });
      if (entry.duration > 0) {
        const timer = setTimeout(() => dismiss(id), entry.duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss, max],
  );

  const ctx = React.useMemo<ToastContextValue>(
    () => ({ toast, dismiss }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      {mounted
        ? createPortal(
            <div
              aria-live="polite"
              className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2.5"
            >
              {toasts.map((t) => (
                <ToastCard key={t.id} entry={t} onDismiss={() => dismiss(t.id)} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

function ToastCard({
  entry,
  onDismiss,
}: {
  entry: ToastEntry;
  onDismiss: () => void;
}) {
  const Icon = variantIcon[entry.variant];
  const role =
    entry.variant === "warn" || entry.variant === "danger"
      ? "alert"
      : "status";
  return (
    <div
      role={role}
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-md border border-border-strong bg-surface-2 p-[14px]",
        "shadow-[var(--shadow-overlay)]",
        "duration-200",
        entry.leaving
          ? "animate-out fade-out-0 slide-out-to-bottom-2"
          : "animate-in fade-in-0 slide-in-from-bottom-2",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-px size-4 flex-none", variantIconClass[entry.variant])}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-fg">{entry.title}</p>
        {entry.description ? (
          <p className="mt-0.5 text-[12.5px] text-muted">{entry.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Fechar notificacao"
        onClick={onDismiss}
        className={cn(
          "-mr-1 -mt-1 grid size-7 flex-none place-items-center rounded-sm text-muted",
          "transition-colors hover:bg-surface-3 hover:text-fg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
        )}
      >
        <X className="size-[15px]" aria-hidden="true" />
      </button>
    </div>
  );
}
