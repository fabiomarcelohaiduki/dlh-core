"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Menu, Settings, UserRound, LogOut, Building2, SlidersHorizontal, LayoutDashboard, Plug } from "lucide-react";
import { screenMeta } from "@/lib/nav";
import { cn } from "@/lib/utils";
import type { FonteConexao } from "@/lib/status";
import { logout } from "@/app/actions/auth";
import { useConfiguracao } from "@/hooks/use-configuracao";

/**
 * Menu de tema carregado client-only (`ssr: false`): ele embute `useTema` ->
 * `useTheme` do next-themes, e rodar esse hook no prerender estatico das
 * paginas do cockpit quebrava o SSG (dispatcher de hooks nulo). Isolado aqui,
 * a topbar segue prerenderavel e o seletor de tema continua global.
 */
const TopbarThemeMenu = dynamic(
  () => import("@/components/cockpit/topbar-theme-menu").then((m) => m.TopbarThemeMenu),
  { ssr: false }
);

/** Rotulo acessivel do estado de conexao por cor. */
const ESTADO_LABEL: Record<string, string> = {
  ok: "conectado",
  err: "com erro",
  warn: "atenção",
  run: "coletando",
  idle: "não configurado",
};

type MenuId = "activity" | "settings" | "account" | "theme";

/**
 * Topbar de acoes globais (SPEC 4.3.2). Espelha o Design Lock: titulo +
 * subtitulo da view + quatro acoes (atividade, configuracoes, tema, conta).
 *
 * - Titulo/subtitulo da view ativa.
 * - Cluster de acoes globais com submenus client-side: `activityButton`
 *   (Notificacoes - ponto de alerta), `globalSettingsButton` (Configuracoes),
 *   `themeButton` (tema) e `accountButton` (Conta). No maximo 1 submenu aberto
 *   por vez, fecha por clique-fora, Escape ou navegacao.
 * - Logout chama `supabase.auth.signOut()` e redireciona para `/login`.
 * - Links de view interna usam o router do Next (Link) sem I/O.
 */
export function Topbar({
  onMenu,
  user,
  conexoes = [],
}: {
  onMenu: () => void;
  user: { email: string };
  conexoes?: FonteConexao[];
}) {
  const pathname = usePathname();
  const { title, subtitle } = screenMeta(pathname);
  const { data: cfg } = useConfiguracao();

  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [isPending, startTransition] = useTransition();
  const clusterRef = useRef<HTMLDivElement>(null);

  // Fecha o submenu ao trocar de rota (navegacao interna via Link).
  useEffect(() => {
    setOpenMenu(null);
  }, [pathname]);

  // Fecha por clique-fora e por Escape.
  useEffect(() => {
    if (!openMenu) return;
    function onPointerDown(e: MouseEvent) {
      if (clusterRef.current && !clusterRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  function toggle(id: MenuId) {
    setOpenMenu((cur) => (cur === id ? null : id));
  }

  function handleLogout() {
    setOpenMenu(null);
    startTransition(async () => {
      // Server action: expira os cookies httpOnly e redireciona para /login.
      await logout();
    });
  }

  // Notificações do ambiente: o indicador da topbar é o único canal visível na
  // Fase 0. O alerta é derivado de configuração/estado (não de tabelas de
  // negócio) e só acende quando `notifyAlerts` está ligado E há sinal pendente
  // (conexão de fonte em erro). Desligar a preferência silencia o ponto.
  const notifyAlerts = cfg?.notifyAlerts ?? true;
  const alerta = notifyAlerts && conexoes.some((c) => c.state === "err");

  return (
    <header className="topbar">
      <button className="menu-btn" type="button" onClick={onMenu} aria-label="Abrir menu">
        <Menu aria-hidden="true" />
      </button>

      <div className="topbar-title">
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>

      <div className="global-actions" ref={clusterRef} aria-label="Ações globais">
        {/* Notificacoes / atividade */}
        <div className="action-cluster">
          <button
            id="activityButton"
            type="button"
            className="icon-button"
            aria-label="Notificações"
            title="Notificações"
            aria-haspopup="menu"
            aria-expanded={openMenu === "activity"}
            data-alert={alerta ? "true" : "false"}
            onClick={() => toggle("activity")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 19V5" />
              <path d="M4 19h16" />
              <path d="M8 15l3-4 3 2 4-7" />
            </svg>
          </button>
          {openMenu === "activity" && (
            <div className="action-menu" role="menu">
              <Link href="/atividade-global" role="menuitem" onClick={() => setOpenMenu(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 19V5" />
                  <path d="M4 19h16" />
                  <path d="M8 15l3-4 3 2 4-7" />
                </svg>
                <span>
                  <strong>Atividade global</strong>
                  <small>Sinais recentes de automações e ingestão.</small>
                </span>
              </Link>
              <div className="action-menu-head">Conexões das fontes</div>
              {conexoes.length === 0 ? (
                <div className="action-menu-empty">Nenhuma fonte configurada.</div>
              ) : (
                conexoes.map((c) => (
                  <div key={c.tipo} className="conn-row" role="menuitem">
                    <span className={cn("conn-dot", c.state)} aria-hidden="true" />
                    <strong>{c.label}</strong>
                    <span>{ESTADO_LABEL[c.state] ?? c.state}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Configuracoes */}
        <div className="action-cluster">
          <button
            id="globalSettingsButton"
            type="button"
            className="icon-button"
            aria-label="Configurações"
            title="Configurações"
            aria-haspopup="menu"
            aria-expanded={openMenu === "settings"}
            onClick={() => toggle("settings")}
          >
            <Settings aria-hidden="true" />
          </button>
          {openMenu === "settings" && (
            <div className="action-menu" role="menu">
              <Link href="/configuracao" role="menuitem" onClick={() => setOpenMenu(null)}>
                <LayoutDashboard aria-hidden="true" />
                <span>
                  <strong>Configuração do cockpit</strong>
                  <small>Cards de módulo e painéis fixos da visão geral.</small>
                </span>
              </Link>
              <Link href="/configuracao-geral" role="menuitem" onClick={() => setOpenMenu(null)}>
                <SlidersHorizontal aria-hidden="true" />
                <span>
                  <strong>Configuração geral</strong>
                  <small>Preferências do ambiente, tema e acessibilidade.</small>
                </span>
              </Link>
              <Link href="/configuracoes-empresa" role="menuitem" onClick={() => setOpenMenu(null)}>
                <Building2 aria-hidden="true" />
                <span>
                  <strong>Configurações da empresa</strong>
                  <small>Dados institucionais e logomarca da DLH.</small>
                </span>
              </Link>
              <Link href="/integracoes-global" role="menuitem" onClick={() => setOpenMenu(null)}>
                <Plug aria-hidden="true" />
                <span>
                  <strong>Integrações</strong>
                  <small>Conectores e autenticações externas.</small>
                </span>
              </Link>
            </div>
          )}
        </div>

        {/* Seletor de tema (ícone contraste) — espelha o protótipo. */}
        <div className="action-cluster">
          <button
            id="themeButton"
            type="button"
            className="icon-button"
            aria-label="Tema"
            title="Tema"
            aria-haspopup="menu"
            aria-expanded={openMenu === "theme"}
            onClick={() => toggle("theme")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {openMenu === "theme" && <TopbarThemeMenu onSelect={() => setOpenMenu(null)} />}
        </div>

        {/* Conta */}
        <div className="action-cluster">
          <button
            id="accountButton"
            type="button"
            className="icon-button"
            aria-label="Conta"
            title="Conta"
            aria-haspopup="menu"
            aria-expanded={openMenu === "account"}
            onClick={() => toggle("account")}
          >
            <UserRound aria-hidden="true" />
          </button>
          {openMenu === "account" && (
            <div className="action-menu" role="menu">
              <div className="action-menu-head">
                <strong>Núcleo DLH</strong>
                <small>{user.email}</small>
              </div>
              <Link href="/conta-google" role="menuitem" onClick={() => setOpenMenu(null)}>
                <UserRound aria-hidden="true" />
                <span>
                  <strong>Conta Google</strong>
                  <small>Sessão autenticada pelo Supabase Auth.</small>
                </span>
              </Link>
              <button
                type="button"
                className="action-menu-item"
                role="menuitem"
                onClick={handleLogout}
                disabled={isPending}
              >
                <LogOut aria-hidden="true" />
                <span>
                  <strong>Sair</strong>
                  <small>Encerrar esta sessão.</small>
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
