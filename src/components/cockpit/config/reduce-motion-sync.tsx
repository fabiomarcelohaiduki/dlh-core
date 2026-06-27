"use client";

import { useEffect } from "react";
import { useConfiguracao } from "@/hooks/use-configuracao";

/**
 * ReduceMotionSync — espelha `configuracao.reduzir_movimento` na classe
 * `body.reduce-motion`, que zera animações/transições em todo o ambiente
 * autenticado (regra global em globals.css). Não renderiza nada.
 */
export function ReduceMotionSync() {
  const { data } = useConfiguracao();
  const reduzir = data?.reduzirMovimento ?? false;

  useEffect(() => {
    document.body.classList.toggle("reduce-motion", reduzir);
    return () => {
      document.body.classList.remove("reduce-motion");
    };
  }, [reduzir]);

  return null;
}
