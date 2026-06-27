"use client";

// =====================================================================
// use-sessao — expiração REAL da sessão por inatividade (SPEC 3.3.3 / 5.1.3).
//
// Arma um timer (setTimeout) que chama signOut + redirect /login após
// `sessionTimeout` minutos sem interação. Qualquer atividade
// (mousemove/keydown/click/scroll/touchstart) rearma a contagem, com throttle
// de 2s para não rearmar a cada pixel. Quando `sessionWarn` está ativo e o
// timeout > 1 min, um aviso (toast) aparece 1 minuto antes do encerramento.
//
// "Nunca expira" (timeout = 0) desarma o timer. O timer só roda enquanto a
// sessão está autenticada (a casca do cockpit só monta autenticada).
//
// Interface: armIdleTimer, doLogout, completeLogin (nomes da SPEC 5.1.3).
// =====================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { logout } from "@/app/actions/auth";
import { useConfiguracao } from "@/hooks/use-configuracao";
import { useSession } from "@/hooks/use-auth";

/** Eventos de atividade que reiniciam a contagem de inatividade. */
const ACTIVITY_EVENTS = [
  "mousemove",
  "keydown",
  "click",
  "scroll",
  "touchstart",
] as const;

/** Throttle do rearme do timer (evita rearmar a cada pixel de mousemove). */
const THROTTLE_MS = 2000;

/** Antecedência do aviso antes do encerramento. */
const WARN_LEAD_MS = 60_000;

/**
 * Chaves de UI no localStorage limpas no logout. NUNCA inclui dado de negócio —
 * apenas preferências efêmeras de layout da casca (sidebar/accordion).
 */
const UI_LOCALSTORAGE_KEYS = ["dlh-sidebar-collapsed", "lionclaw.nav-expanded"];

export interface UseSessaoResult {
  /** true quando faltam ~1 min para o encerramento (estado session-warning). */
  warning: boolean;
  /** Encerra a sessão imediatamente (signOut + redirect /login). */
  doLogout: () => Promise<void>;
}

/**
 * Hook de expiração de sessão por inatividade. Deve ser montado uma única vez
 * dentro da casca autenticada (CockpitShell).
 */
export function useSessao(): UseSessaoResult {
  const { status } = useSession();
  const { data: cfg } = useConfiguracao();

  const authenticated = status === "authenticated";
  const timeoutMin = cfg?.sessionTimeout ?? 0;
  const warnEnabled = cfg?.sessionWarn ?? false;

  const [warning, setWarning] = useState(false);

  const logoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const throttleLock = useRef(false);

  const clearTimers = useCallback(() => {
    if (logoutTimer.current) {
      clearTimeout(logoutTimer.current);
      logoutTimer.current = null;
    }
    if (warnTimer.current) {
      clearTimeout(warnTimer.current);
      warnTimer.current = null;
    }
  }, []);

  /** Encerra a sessão: limpa timers, remove chaves de UI e desloga. */
  const doLogout = useCallback(async () => {
    clearTimers();
    setWarning(false);
    try {
      for (const key of UI_LOCALSTORAGE_KEYS) {
        localStorage.removeItem(key);
      }
    } catch {
      // localStorage indisponível (modo privado): ignora — não bloqueia o logout.
    }
    // Server action: expira os cookies httpOnly server-side (o client browser
    // nao alcanca cookies httpOnly). reason=expired: a tela /login exibe o aviso
    // honesto de expiracao por inatividade (EC-03). Distinto do logout manual,
    // que volta limpo a /login.
    await logout("/login?reason=expired");
  }, [clearTimers]);

  /** (Re)arma os timers de aviso e de encerramento conforme a config vigente. */
  const armIdleTimer = useCallback(() => {
    clearTimers();
    setWarning(false);
    if (!timeoutMin || !authenticated) return;

    const expireMs = timeoutMin * 60_000;
    if (warnEnabled && timeoutMin > 1) {
      warnTimer.current = setTimeout(() => {
        setWarning(true);
      }, expireMs - WARN_LEAD_MS);
    }
    logoutTimer.current = setTimeout(() => {
      void doLogout();
    }, expireMs);
  }, [authenticated, timeoutMin, warnEnabled, clearTimers, doLogout]);

  /** Arma a contagem após o login (interface nomeada na SPEC 5.1.3). */
  const completeLogin = useCallback(() => {
    armIdleTimer();
  }, [armIdleTimer]);

  // Monta listeners de atividade e arma o timer enquanto a sessão estiver ativa
  // e com timeout > 0. Reage a mudanças de timeout/warn (config ao vivo).
  useEffect(() => {
    if (!authenticated || !timeoutMin) {
      clearTimers();
      setWarning(false);
      return;
    }

    // Armado no login / montagem da casca autenticada.
    completeLogin();

    function onActivity() {
      if (throttleLock.current) return;
      throttleLock.current = true;
      window.setTimeout(() => {
        throttleLock.current = false;
      }, THROTTLE_MS);
      armIdleTimer();
    }

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, onActivity, { passive: true });
    }

    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, onActivity);
      }
      clearTimers();
    };
  }, [authenticated, timeoutMin, warnEnabled, armIdleTimer, completeLogin, clearTimers]);

  return { warning, doLogout };
}
