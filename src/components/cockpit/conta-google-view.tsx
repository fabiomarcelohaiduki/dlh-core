"use client";

// =====================================================================
// conta-google-view — painel da conta autenticada (SPEC 4.3.3 / 4.8.x).
//
// Mostra a identidade conhecida pela casca (email da sessão), o estado da
// integração de auth e a pill de sessão (#accountSessionPill) com o tempo de
// expiração por inatividade lido da Configuração geral. O botão de logout
// chama signOut e redireciona para /login (reaproveita doLogout do use-sessao).
// =====================================================================

import { useTransition } from "react";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { logout } from "@/app/actions/auth";
import { useConfiguracao } from "@/hooks/use-configuracao";
import { useSession } from "@/hooks/use-auth";
import { useSessaoContext } from "@/components/cockpit/sessao-provider";
import type { PillState } from "@/lib/status";

/**
 * Estado visual da pill de sessão (#accountSessionPill, EC-20), derivado do
 * estado real da sessão e do sinal de inatividade do SessaoProvider:
 *  - danger (err) → sessão expirada (não autenticada);
 *  - warn         → expirando (~1 min antes do encerramento por inatividade);
 *  - ok           → ativa.
 * Reusa o vocabulário travado de PillState (status-pill / globals.css).
 */
function sessionPill(
  authenticated: boolean,
  warning: boolean,
  timeoutLabel: string,
): { state: PillState; label: string } {
  if (!authenticated) return { state: "err", label: "Sessão expirada" };
  if (warning) return { state: "warn", label: "Expira em instantes" };
  return { state: "ok", label: timeoutLabel };
}

/** Formata o timeout (min) no rótulo humano usado pela pill de sessão. */
function humanTimeout(mins: number): string {
  if (!mins) return "Sem expiração";
  if (mins < 60) return `${mins} min`;
  const horas = mins / 60;
  return `${horas} ${horas === 1 ? "hora" : "horas"}`;
}

export function ContaGoogleView() {
  const { user, status } = useSession();
  const { data: cfg } = useConfiguracao();
  const { warning } = useSessaoContext();
  const [isPending, startTransition] = useTransition();

  const sessionLabel = humanTimeout(cfg?.sessionTimeout ?? 0);
  const pill = sessionPill(
    status === "authenticated",
    warning,
    sessionLabel,
  );

  function handleLogout() {
    startTransition(async () => {
      // Server action: expira os cookies httpOnly e redireciona para /login.
      await logout();
    });
  }

  return (
    <section className="global-view">
      <section className="cfg-panel-card" aria-labelledby="conta-google-h">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="conta-google-h">Conta</h3>
            <p>Sessão autenticada com Google pelo Supabase Auth.</p>
          </div>
          <span className="pill ok">Autenticado</span>
        </div>
        <ul className="stack-list">
          <li className="stack-item">
            <div className="stack-copy">
              <strong>Identidade</strong>
              <span>{user?.email ?? "Sessão local autenticada."}</span>
            </div>
            <span className="pill ok">Ativo</span>
          </li>
          <li className="stack-item">
            <div className="stack-copy">
              <strong>Provedor</strong>
              <span>Google OAuth via Supabase Auth.</span>
            </div>
            <span className="pill ok">Ativo</span>
          </li>
          <li className="stack-item">
            <div className="stack-copy">
              <strong>Sessão local</strong>
              <span>
                Expiração por inatividade definida na Configuração geral. Saída
                manual no submenu ou na lateral.
              </span>
            </div>
            <span
              className={cn("pill", pill.state)}
              id="accountSessionPill"
              aria-label={`Sessão: ${pill.label}`}
            >
              <span className="dot" aria-hidden="true" />
              {pill.label}
            </span>
          </li>
        </ul>
        <div className="conta-google-actions">
          <button
            type="button"
            className="btn"
            onClick={handleLogout}
            disabled={isPending}
          >
            <LogOut aria-hidden="true" width={16} height={16} />
            {isPending ? "Encerrando…" : "Encerrar sessão"}
          </button>
        </div>
      </section>
    </section>
  );
}
