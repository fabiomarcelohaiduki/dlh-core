"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Menu, Activity, Settings, UserRound, LogOut, Building2, SlidersHorizontal, LayoutDashboard, Plug, Search, RefreshCw } from "lucide-react";
import { screenMeta, SCREEN_TITLES } from "@/lib/nav";
import { cn } from "@/lib/utils";
import type { FonteConexao } from "@/lib/status";
import { logout } from "@/app/actions/auth";
import { useConfiguracao } from "@/hooks/use-configuracao";
import { DlhLogo } from "@/components/cockpit/dlh-logo";

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

type MenuId = "search" | "activity" | "settings" | "account" | "theme";

/**
 * Topbar de acoes globais (SPEC 4.3.2 / delta-04/05/25/26).
 *
 * - `lionclawBrand`: marca LionClaw a esquerda, atalho para o cockpit.
 * - Titulo/subtitulo da view ativa.
 * - Cluster de acoes globais com submenus client-side: `globalSearchButton`
 *   (busca de telas), `activityButton` (Notificacoes, delta-25 - ponto de
 *   alerta), `globalSettingsButton` (Configuracoes) e `accountButton` (Conta).
 *   Mais o `syncButton` (delta-26 - sync manual do cockpit via router.refresh,
 *   com ponto de alerta). No maximo 1 submenu aberto por vez, fecha por
 *   clique-fora, Escape ou navegacao.
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
  const router = useRouter();
  const { title, subtitle } = screenMeta(pathname);
  const { data: cfg } = useConfiguracao();

  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const [isSyncing, startSync] = useTransition();
  const clusterRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Indice de busca global (delta-04/05): mapeia rotas reais -> titulo. Exclui
  // rotas parametrizadas (com segmento dinamico) que nao sao navegaveis direto.
  const searchIndex = useMemo(
    () =>
      Object.entries(SCREEN_TITLES)
        .filter(([href]) => !href.includes("["))
        .map(([href, label]) => ({ href, label })),
    []
  );
  const normalizedQuery = query.trim().toLowerCase();
  const searchResults = normalizedQuery
    ? searchIndex.filter((e) => e.label.toLowerCase().includes(normalizedQuery)).slice(0, 8)
    : searchIndex.slice(0, 6);

  // Fecha o submenu ao trocar de rota (navegacao interna via Link).
  useEffect(() => {
    setOpenMenu(null);
    setQuery("");
  }, [pathname]);

  // Foca o campo de busca ao abrir o submenu de busca global.
  useEffect(() => {
    if (openMenu === "search") searchInputRef.current?.focus();
  }, [openMenu]);

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
    setOpenMenu((cur) => {
      const next = cur === id ? null : id;
      if (next !== "search") setQuery("");
      return next;
    });
  }

  // Sync manual do cockpit (delta-26): reexecuta os Server Components do shell
  // (router.refresh) para reconsolidar sinais/estado sem recarregar a pagina.
  function handleSync() {
    setOpenMenu(null);
    startSync(() => {
      router.refresh();
    });
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

      {/* Marca LionClaw — atalho para o cockpit (SPEC 4.3.2, lionclawBrand). */}
      <Link id="lionclawBrand" href="/dashboard" className="topbar-brand" aria-label="LionClaw — ir para o cockpit">
        <span className="mini-logo topbar-brand-glyph" aria-hidden="true">
          <DlhLogo size={30} />
        </span>
        <span className="topbar-brand-name">DLH Core</span>
      </Link>

      <div className="topbar-title">
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>

      <div className="global-actions" ref={clusterRef} aria-label="Ações globais">
        {/* Busca global (delta-04/05) — submenu com campo e atalhos de tela. */}
        <div className="action-cluster">
          <button
            id="globalSearchButton"
            type="button"
            className="icon-button"
            aria-label="Busca global"
            title="Busca global"
            aria-haspopup="menu"
            aria-expanded={openMenu === "search"}
            onClick={() => toggle("search")}
          >
            <Search aria-hidden="true" />
          </button>
          {openMenu === "search" && (
            <div className="action-menu action-menu-search" role="menu">
              <div className="action-search">
                <Search aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar telas do cockpit"
                  aria-label="Buscar telas do cockpit"
                />
              </div>
              {searchResults.length === 0 ? (
                <div className="action-menu-empty">Nenhuma tela encontrada.</div>
              ) : (
                searchResults.map((r) => (
                  <Link key={r.href} href={r.href} role="menuitem" onClick={() => setOpenMenu(null)}>
                    <LayoutDashboard aria-hidden="true" />
                    <span>
                      <strong>{r.label}</strong>
                      <small>{r.href}</small>
                    </span>
                  </Link>
                ))
              )}
            </div>
          )}
        </div>

        {/* Sync manual do cockpit (delta-26) — ponto de alerta quando ha sinal pendente. */}
        <div className="action-cluster">
          <button
            id="syncButton"
            type="button"
            className="icon-button"
            aria-label="Sincronizar cockpit"
            title="Sincronizar cockpit"
            data-alert={alerta ? "true" : "false"}
            onClick={handleSync}
            disabled={isSyncing}
          >
            <RefreshCw aria-hidden="true" className={cn(isSyncing && "spin")} />
          </button>
        </div>

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
            <Activity aria-hidden="true" />
          </button>
          {openMenu === "activity" && (
            <div className="action-menu" role="menu">
              <Link href="/atividade-global" role="menuitem" onClick={() => setOpenMenu(null)}>
                <Activity aria-hidden="true" />
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
