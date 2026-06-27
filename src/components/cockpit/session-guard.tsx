"use client";

import { TriangleAlert } from "lucide-react";
import { useSessaoContext } from "@/components/cockpit/sessao-provider";

/**
 * SessionGuard — exibe o aviso efêmero ~1 min antes do encerramento por
 * inatividade (estado session-warning). O timer/política vivem na instância
 * única de `useSessao` do SessaoProvider; aqui apenas consumimos o sinal
 * `warning` via contexto (evita rearmar um segundo timer).
 *
 * Não renderiza nada além do toast de aviso; o encerramento real (signOut +
 * redirect /login) é tratado pelo hook. Respeita "reduzir movimento" via a
 * regra global de `body.reduce-motion` aplicada à animação do `.cfg-toast`.
 */
export function SessionGuard() {
  const { warning } = useSessaoContext();

  if (!warning) return null;

  return (
    <div role="status" aria-live="polite" className="cfg-toast is-err">
      <TriangleAlert aria-hidden="true" width={16} height={16} />
      Sua sessão expira em 1 minuto por inatividade.
    </div>
  );
}
