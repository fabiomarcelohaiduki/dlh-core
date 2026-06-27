// =====================================================================
// IntegracoesPainel — estado READ-ONLY das integrações pré-existentes.
//
// Apresentação pura (sem client): lê o estado de conexão já hidratado no
// servidor (loadConexoesFontes, mesma fonte do indicador do Topbar) e mostra,
// por conector, a pill com a semântica travada do Design Lock:
//  - ok   (conectada);
//  - idle (desconectada / não configurada) → "muted" do EC-22;
//  - err  (token expirado / erro de conexão) → "danger" do EC-22.
//
// Nesta entrega é apenas exibição: nenhuma ação de reconexão é oferecida aqui.
// =====================================================================

import { StatusPill } from "@/components/cockpit/status-pill";
import type { FonteConexao, PillState } from "@/lib/status";

/** Rótulo da pill por estado de conexão (semântica EC-22). */
const PILL_LABEL: Record<PillState, string> = {
  ok: "Conectada",
  run: "Sincronizando",
  warn: "Atenção",
  err: "Token expirado",
  idle: "Desconectada",
};

/** Descrição read-only por conector pré-existente. */
const CONECTOR_DESC: Record<FonteConexao["tipo"], string> = {
  nomus: "ERP Nomus — processos e pessoas via API REST.",
  effecti: "Portal Effecti — avisos e editais de licitação.",
  drive: "Conta Google Drive para coleta de documentos.",
  gmail: "Conta Gmail para coleta de mensagens.",
};

/** Ordem de exibição dos conectores (Nomus primeiro, conforme a sprint). */
const ORDER: FonteConexao["tipo"][] = ["nomus", "effecti", "drive", "gmail"];

/** Resumo do cabeçalho: erro vence; senão tudo conectado = ok; senão parcial. */
function resumo(conexoes: FonteConexao[]): { state: PillState; label: string } {
  if (conexoes.some((c) => c.state === "err")) {
    return { state: "err", label: "Verificar" };
  }
  if (conexoes.length > 0 && conexoes.every((c) => c.state === "ok")) {
    return { state: "ok", label: "Operacional" };
  }
  return { state: "idle", label: "Parcial" };
}

export function IntegracoesPainel({
  conexoes,
}: {
  conexoes: FonteConexao[];
}) {
  const ordered = ORDER.map((tipo) =>
    conexoes.find((c) => c.tipo === tipo),
  ).filter((c): c is FonteConexao => Boolean(c));
  const header = resumo(ordered);

  return (
    <section className="cfg-panel-card" aria-labelledby="integracoes-conectores-h">
      <div className="panel-header">
        <div className="panel-title">
          <h3 id="integracoes-conectores-h">Conectores de ingestão</h3>
          <p>
            Estado da conexão de cada serviço externo. A configuração das
            credenciais é feita em Fontes e credenciais — aqui é apenas leitura.
          </p>
        </div>
        <StatusPill state={header.state} label={header.label} />
      </div>
      <ul className="stack-list">
        {ordered.map((c) => (
          <li className="stack-item" key={c.tipo}>
            <div className="stack-copy">
              <strong>{c.label}</strong>
              <span>{CONECTOR_DESC[c.tipo]}</span>
            </div>
            <StatusPill state={c.state} label={PILL_LABEL[c.state]} />
          </li>
        ))}
      </ul>
    </section>
  );
}
