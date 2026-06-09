"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { useIngestaoConfig, useSalvarIngestaoConfig } from "@/hooks/use-fontes";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { RecursoConfig } from "@/lib/api/types";

/**
 * Recursos da fonte Nomus (config_ingestao.recursos). `processos` e o unico
 * ATIVO/editavel nesta entrega; os demais sao futuros — visiveis e desligados
 * (toggle inerte). `key` casa 1:1 com a allowlist RECURSOS_PERMITIDOS do backend.
 */
const RECURSOS = [
  { key: "processos", label: "Processos", descricao: "Processos comerciais (ativo)", futuro: false },
  { key: "cobranca", label: "Cobrança", descricao: "Títulos e cobranças", futuro: true },
  { key: "propostas", label: "Propostas", descricao: "Propostas comerciais", futuro: true },
  { key: "pedidos", label: "Pedidos", descricao: "Pedidos de venda", futuro: true },
  { key: "nfes", label: "NF-es", descricao: "Notas fiscais eletrônicas", futuro: true },
  {
    key: "contas_a_receber",
    label: "Contas a Receber",
    descricao: "Lançamentos financeiros",
    futuro: true,
  },
] as const;

/**
 * Tipos disponiveis por recurso. Nesta entrega so Processos expoe tipos. Os
 * rotulos sao os LITERAIS exatos do campo `tipo` do Nomus — o allowlist
 * (tipos_ativos) compara string exata, entao "Cobrança DARLU" leva a cedilha.
 */
const TIPOS_POR_RECURSO: Record<string, string[]> = {
  processos: ["Venda Governamental", "Cobrança DARLU"],
};

interface RecursoFormState {
  ativo: boolean;
  tiposAtivos: string[];
  /** Janela por recurso: corte por id (texto do input; "" = sem corte). */
  idInicial: string;
  /** Janela por recurso: corte por data 'YYYY-MM-DD' ("" = sem corte). */
  dataInicial: string;
}
type RecursosState = Record<string, RecursoFormState>;

type Feedback = { kind: "ok" | "err"; message: string };

/** Estado default de um recurso quando o backend ainda nao tem config. */
function defaultRecurso(key: string, futuro: boolean): RecursoFormState {
  if (key === "processos") {
    return {
      ativo: true,
      tiposAtivos: ["Venda Governamental", "Cobrança DARLU"],
      idInicial: "",
      dataInicial: "",
    };
  }
  return { ativo: !futuro, tiposAtivos: [], idInicial: "", dataInicial: "" };
}

/** Hidrata o estado do form a partir do snapshot vindo do GET ingestao-config. */
function hydrate(recursos: Record<string, RecursoConfig>): RecursosState {
  const next: RecursosState = {};
  for (const r of RECURSOS) {
    const cfg = recursos[r.key];
    next[r.key] = cfg
      ? {
          ativo: cfg.ativo,
          tiposAtivos: cfg.tiposAtivos,
          idInicial:
            typeof cfg.idInicial === "number" ? String(cfg.idInicial) : "",
          dataInicial:
            typeof cfg.dataInicial === "string" ? cfg.dataInicial.slice(0, 10) : "",
        }
      : defaultRecurso(r.key, r.futuro);
  }
  return next;
}

/** Toggle de um recurso (Switch-like, padrao .chk do Design Lock). */
function RecursoToggle({
  label,
  descricao,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  descricao?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn("chk", checked && "on", disabled && "disabled")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="t">
        {label}
        {descricao && <small>{descricao}</small>}
      </div>
    </label>
  );
}

/** Toggle de um tipo dentro de um recurso. */
function TipoToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn("chk", checked && "on", disabled && "disabled")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="t">{label}</div>
    </label>
  );
}

/**
 * cmp-nomus-cfg-form — Configuracao da ingestao Nomus (US-04/US-05).
 *
 * Toggles de recursos e de tipos por recurso + data de corte da coleta
 * (data_inicial): o processo do Nomus nao tem data de alteracao, entao a janela
 * movel por dias nao se aplica; o corte e por DATA DE CRIACAO (>= data_inicial).
 * Consome useIngestaoConfig (GET) para hidratar e useSalvarIngestaoConfig (PUT)
 * para persistir; as alteracoes valem na PROXIMA execucao (sem redeploy).
 * Estados de loading (skeleton) e erro (inline) presentes na leitura e gravacao.
 */
export function NomusCfgForm() {
  const config = useIngestaoConfig("nomus");
  const salvar = useSalvarIngestaoConfig();

  const [recursos, setRecursos] = useState<RecursosState>({});
  const [dirty, setDirty] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<Feedback | null>(null);
  const hydratedRef = useRef(false);

  // Hidratacao unica quando o GET resolve (nao sobrescreve edicoes do usuario).
  useEffect(() => {
    if (hydratedRef.current || !config.data) return;
    setRecursos(hydrate(config.data.recursos));
    hydratedRef.current = true;
  }, [config.data]);

  function toggleRecurso(key: string, ativo: boolean) {
    setRecursos((prev) => ({ ...prev, [key]: { ...prev[key], ativo } }));
    setDirty(true);
    setSaveFeedback(null);
  }

  function setJanela(key: string, campo: "idInicial" | "dataInicial", valor: string) {
    setRecursos((prev) => ({ ...prev, [key]: { ...prev[key], [campo]: valor } }));
    setDirty(true);
    setSaveFeedback(null);
  }

  function toggleTipo(key: string, tipo: string, on: boolean) {
    setRecursos((prev) => {
      const current = prev[key]?.tiposAtivos ?? [];
      const tiposAtivos = on
        ? Array.from(new Set([...current, tipo]))
        : current.filter((t) => t !== tipo);
      return { ...prev, [key]: { ...prev[key], tiposAtivos } };
    });
    setDirty(true);
    setSaveFeedback(null);
  }

  async function handleSave() {
    if (salvar.isPending) return;
    setSaveFeedback(null);
    try {
      await salvar.mutateAsync({
        fonte: "nomus",
        recursos: Object.fromEntries(
          RECURSOS.map((r) => {
            const s = recursos[r.key];
            // Janela por recurso: "" limpa o corte (null); senao envia o valor.
            const idTrim = (s?.idInicial ?? "").trim();
            const idNum = idTrim === "" ? null : Number(idTrim);
            const dataTrim = (s?.dataInicial ?? "").trim();
            return [
              r.key,
              {
                ativo: s?.ativo ?? false,
                tiposAtivos: s?.tiposAtivos ?? [],
                idInicial:
                  idTrim !== "" && Number.isFinite(idNum) ? Math.floor(idNum as number) : null,
                dataInicial: dataTrim === "" ? null : dataTrim,
              },
            ];
          }),
        ),
      });
      setDirty(false);
      setSaveFeedback({ kind: "ok", message: "Configuração salva · vale na próxima execução" });
    } catch (err) {
      const message =
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? "Dados inválidos: revise a data e as seleções."
          : "Não foi possível salvar a configuração. Tente novamente.";
      setSaveFeedback({ kind: "err", message });
    }
  }

  // Skeleton de carregamento (leitura da config).
  if (config.isLoading) {
    return (
      <form className="card form-card" aria-busy="true">
        <div className="section-title" style={{ margin: "0 0 16px" }}>
          <h3>Recursos e tipos</h3>
        </div>
        <div className="chk-grid">
          {RECURSOS.map((r) => (
            <div key={r.key} className="chk disabled" style={{ opacity: 0.6 }}>
              <div className="t">
                Carregando…
                <small>&nbsp;</small>
              </div>
            </div>
          ))}
        </div>
      </form>
    );
  }

  // Erro de leitura da config.
  if (config.isError) {
    return (
      <div className="banner">
        <TriangleAlert aria-hidden="true" />
        <div>
          <b>Não foi possível carregar a configuração</b>
          <p>Atualize a página para tentar novamente.</p>
        </div>
      </div>
    );
  }

  return (
    <form
      className="card form-card"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSave();
      }}
      noValidate
    >
      <div className="section-title" style={{ margin: "0 0 6px" }}>
        <h3>Nomus · Recursos</h3>
      </div>
      <div className="helper" style={{ margin: "-2px 0 16px" }}>
        Cada recurso (módulo) tem o próprio liga/desliga, tipos e janela de coleta. Os módulos
        futuros entram em fases seguintes.
      </div>

      <div style={{ display: "grid", gap: 16 }}>
        {RECURSOS.map((r) => {
          const s = recursos[r.key];
          const ativo = s?.ativo ?? false;
          const tipos = TIPOS_POR_RECURSO[r.key] ?? [];
          return (
            <div
              key={r.key}
              className="card"
              style={{ padding: 16, opacity: r.futuro ? 0.65 : 1 }}
            >
              <RecursoToggle
                label={r.label}
                descricao={r.descricao}
                checked={ativo}
                disabled={r.futuro}
                onChange={(on) => toggleRecurso(r.key, on)}
              />

              {!r.futuro && ativo && tipos.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div className="section-title" style={{ margin: "0 0 10px" }}>
                    <h3>Tipos</h3>
                  </div>
                  <div className="chk-grid">
                    {tipos.map((tipo) => {
                      const on = s?.tiposAtivos?.includes(tipo) ?? false;
                      return (
                        <TipoToggle
                          key={tipo}
                          label={tipo}
                          checked={on}
                          onChange={(checked) => toggleTipo(r.key, tipo, checked)}
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              {!r.futuro && ativo && (
                <div style={{ marginTop: 16 }}>
                  <div className="section-title" style={{ margin: "0 0 8px" }}>
                    <h3>Janela de coleta</h3>
                  </div>
                  <div className="helper" style={{ margin: "-4px 0 10px" }}>
                    Janela de partida própria deste recurso. Deixe em branco para coletar todo o
                    histórico.
                  </div>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <div className="field" style={{ maxWidth: 240 }}>
                      <label htmlFor={`nomus-id-inicial-${r.key}`}>Coletar a partir do id</label>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        id={`nomus-id-inicial-${r.key}`}
                        value={s?.idInicial ?? ""}
                        placeholder="ex.: 25000"
                        onChange={(e) => setJanela(r.key, "idInicial", e.target.value)}
                      />
                      <div className="helper">
                        Ignora registros com <b>id</b> menor que este.
                      </div>
                    </div>
                    <div className="field" style={{ maxWidth: 240 }}>
                      <label htmlFor={`nomus-data-inicial-${r.key}`}>Coletar a partir da data</label>
                      <input
                        type="date"
                        id={`nomus-data-inicial-${r.key}`}
                        value={s?.dataInicial ?? ""}
                        onChange={(e) => setJanela(r.key, "dataInicial", e.target.value)}
                      />
                      <div className="helper">
                        Ignora registros criados antes desta <b>data</b>.
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="form-foot" style={{ marginTop: 26 }}>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={salvar.isPending}
        >
          {salvar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{salvar.isPending ? "Salvando…" : "Salvar configuração"}</span>
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            if (config.data) {
              setRecursos(hydrate(config.data.recursos));
            }
            setDirty(false);
            setSaveFeedback(null);
          }}
          disabled={!dirty || salvar.isPending}
        >
          Descartar alterações
        </button>
        {saveFeedback && (
          <span className={cn("save-note", saveFeedback.kind === "err" && "err")}>
            {saveFeedback.kind === "err" ? (
              <TriangleAlert aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {saveFeedback.message}
          </span>
        )}
      </div>
    </form>
  );
}
