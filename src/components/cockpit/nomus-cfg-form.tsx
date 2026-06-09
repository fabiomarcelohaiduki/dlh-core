"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { useIngestaoConfig, useSalvarIngestaoConfig } from "@/hooks/use-fontes";
import { ConfigSectionHeading } from "@/components/cockpit/source-card";
import { AgendamentoFonteForm } from "@/components/cockpit/agendamento-fonte-form";
import { NomusDisparoForm } from "@/components/cockpit/nomus-disparo-form";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { AgendamentoFonteState, RecursoConfig } from "@/lib/api/types";

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

/** Nomes dos dias da semana (0 = domingo) para o resumo do agendamento. */
const DIAS_SEMANA = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
] as const;

/**
 * Resumo em PT-BR de QUANDO o agendamento dispara a varredura. Reflete o que
 * esta de fato no pg_cron (vem do GET agendamento-fonte-config, lado servidor);
 * null quando a coleta automatica esta desligada.
 */
function resumoAgendamento(ag?: AgendamentoFonteState): string | null {
  if (!ag || !ag.ativo) return null;
  const hora = ag.horarioReferencia ?? "07:00";
  switch (ag.frequencia) {
    case "horaria":
      return `a cada hora, no minuto :${hora.slice(3, 5)}`;
    case "diaria":
      return `todos os dias às ${hora}`;
    case "semanal":
      return `toda ${DIAS_SEMANA[ag.diaSemana ?? 1]} às ${hora}`;
    case "mensal":
      return `todo dia ${ag.diaMes ?? 1} às ${hora}`;
    default:
      return null;
  }
}

interface RecursoFormState {
  ativo: boolean;
  tiposAtivos: string[];
}
type RecursosState = Record<string, RecursoFormState>;

type Feedback = { kind: "ok" | "err"; message: string };

/** Estado default de um recurso quando o backend ainda nao tem config. */
function defaultRecurso(key: string, futuro: boolean): RecursoFormState {
  if (key === "processos") {
    return {
      ativo: true,
      tiposAtivos: ["Venda Governamental", "Cobrança DARLU"],
    };
  }
  return { ativo: !futuro, tiposAtivos: [] };
}

/** Hidrata o estado do form a partir do snapshot vindo do GET ingestao-config. */
function hydrate(recursos: Record<string, RecursoConfig>): RecursosState {
  const next: RecursosState = {};
  for (const r of RECURSOS) {
    const cfg = recursos[r.key];
    next[r.key] = cfg
      ? { ativo: cfg.ativo, tiposAtivos: cfg.tiposAtivos }
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
 * Toggles de recursos e de tipos por recurso. A janela deslizante (janela_dias)
 * e exibida apenas como informacao (configurada no banco, 365 dias p/ processos):
 * o regime diario re-varre os registros dessa janela e atualiza o que mudou; o
 * backfill completo do historico e disparado pela coleta manual (full).
 * Consome useIngestaoConfig (GET) para hidratar e useSalvarIngestaoConfig (PUT)
 * para persistir; as alteracoes valem na PROXIMA execucao (sem redeploy).
 * Estados de loading (skeleton) e erro (inline) presentes na leitura e gravacao.
 */
export function NomusCfgForm({ agendamento }: { agendamento?: AgendamentoFonteState }) {
  const config = useIngestaoConfig("nomus");
  const salvar = useSalvarIngestaoConfig();
  const quando = resumoAgendamento(agendamento);

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
            return [
              r.key,
              {
                ativo: s?.ativo ?? false,
                tiposAtivos: s?.tiposAtivos ?? [],
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

  const header = (
    <ConfigSectionHeading
      title="Configuração da ingestão"
      description="Quais recursos (módulos) do Nomus esta fonte deve ingerir e os tipos de cada um. Os módulos futuros entram em fases seguintes."
    />
  );

  // Skeleton de carregamento (leitura da config).
  if (config.isLoading) {
    return (
      <>
        {header}
        <form className="card form-card" aria-busy="true">
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
      </>
    );
  }

  // Erro de leitura da config.
  if (config.isError) {
    return (
      <>
        {header}
        <div className="banner">
          <TriangleAlert aria-hidden="true" />
          <div>
            <b>Não foi possível carregar a configuração</b>
            <p>Atualize a página para tentar novamente.</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <form
        className="card form-card"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
        noValidate
      >
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

              {r.key === "processos" && agendamento && (
                <div style={{ marginTop: 16 }}>
                  <AgendamentoFonteForm initial={agendamento} />
                  <NomusDisparoForm recurso={r.key} />
                </div>
              )}

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

              {!r.futuro && ativo && (() => {
                const janelaDias = config.data?.recursos?.[r.key]?.janelaDias ?? null;
                if (janelaDias === null) return null;
                return (
                  <div style={{ marginTop: 16 }}>
                    <div className="section-title" style={{ margin: "0 0 8px" }}>
                      <h3>Janela de coleta</h3>
                    </div>
                    <div className="helper">
                      Janela deslizante de <b>{janelaDias} dias</b> (configurada no banco). A
                      coleta automática re-varre os registros dos últimos {janelaDias} dias e
                      atualiza o que mudou.{" "}
                      {quando ? (
                        <>
                          A varredura roda <b>{quando}</b> (horário de Brasília), conforme o
                          Agendamento da coleta acima.
                        </>
                      ) : (
                        <>
                          A coleta automática está <b>desligada</b>; ligue-a no Agendamento da
                          coleta acima para a varredura rodar sozinha.
                        </>
                      )}{" "}
                      Para recarregar o histórico inteiro (sem janela), use{" "}
                      <b>Recarregar histórico (full)</b> na coleta manual acima.
                    </div>
                  </div>
                );
              })()}
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
    </>
  );
}
