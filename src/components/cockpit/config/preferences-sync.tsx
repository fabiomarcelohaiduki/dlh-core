"use client";

import { useEffect } from "react";
import { useConfiguracao } from "@/hooks/use-configuracao";
import { useTema } from "@/hooks/use-tema";

/**
 * PreferencesSync — reaplica, no boot autenticado, as preferencias do ambiente
 * que vivem como estado global (classes em `body` + tema do next-themes).
 *
 * O bootstrap das preferencias e disparado pelo `queryFn` de `useConfiguracao`
 * (cria a linha default no primeiro acesso + migrador localStorage -> Supabase).
 * Aqui apenas espelhamos o resultado:
 *   - densidade   -> `body.compact` / `body.comfortable` (setDensity);
 *   - destacar pendencias -> `body.highlight-pending` (setHighlightPending);
 *   - tema        -> next-themes via `useTema` (setTheme).
 *
 * `setReduceMotion` (body.reduce-motion) fica em `ReduceMotionSync` e
 * `armIdleTimer` em `SessionGuard`, ambos montados no mesmo shell.
 *
 * EC-05 (degradacao): se o bootstrap/Supabase falhar, `data` fica `undefined`
 * e caimos nos defaults (confortavel + destacar pendencias) — anti-flash, sem
 * tela branca e sem sobrescrever a preferencia persistida (apenas leitura).
 */
export function PreferencesSync() {
  // Espelha `configuracao.tema_id` no next-themes (reaplica o tema no boot).
  useTema();

  const { data } = useConfiguracao();
  const densidade = data?.densidade ?? "confortavel";
  const highlightPendencias = data?.highlightPendencias ?? true;

  // Densidade global das tabelas (faithful ao artifact: body.compact/comfortable).
  useEffect(() => {
    const { classList } = document.body;
    classList.toggle("compact", densidade === "compacta");
    classList.toggle("comfortable", densidade === "confortavel");
    return () => {
      classList.remove("compact", "comfortable");
    };
  }, [densidade]);

  // Destacar pendencias: contorno/peso reais em todo .pill.warn (regra global).
  useEffect(() => {
    document.body.classList.toggle("highlight-pending", highlightPendencias);
    return () => {
      document.body.classList.remove("highlight-pending");
    };
  }, [highlightPendencias]);

  return null;
}
