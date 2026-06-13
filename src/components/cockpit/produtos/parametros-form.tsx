"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import {
  useParametros,
  useParametrosRegional,
  useUpsertParametros,
  useUpsertParametrosRegional,
} from "@/hooks/use-parametros";
import { useParametrosResolvidos } from "@/hooks/use-parametros-resolvidos";
import { ApiError } from "@/lib/api/client";
import { StatusPill } from "@/components/cockpit/status-pill";
import { cn } from "@/lib/utils";
import type {
  ParametroEscalarCampo,
  ParametroNivel,
  Regiao,
} from "@/lib/api/types";

const ESCALARES: {
  campo: ParametroEscalarCampo;
  label: string;
  suffix: string;
}[] = [
  { campo: "impostos_pct", label: "Impostos", suffix: "%" },
  { campo: "frete_pct", label: "Frete", suffix: "%" },
  { campo: "despesas_pct", label: "Despesas", suffix: "%" },
  { campo: "lucro_pct", label: "Lucro alvo", suffix: "%" },
  { campo: "lucro_minimo_pct", label: "Lucro mínimo", suffix: "%" },
  { campo: "taxa_horaria", label: "Custo hora de produção", suffix: "R$/h" },
];

const REGIOES: { value: Regiao; label: string }[] = [
  { value: "S", label: "Sul" },
  { value: "SE", label: "Sudeste" },
  { value: "CO", label: "Centro-Oeste" },
  { value: "NE", label: "Nordeste" },
  { value: "N", label: "Norte" },
];

/** Rotulo + classe do badge de origem (nivel efetivo) de cada valor. */
function origemTag(origem: ParametroNivel): { label: string; cls: string } {
  switch (origem) {
    case "produto":
      return { label: "PRODUTO", cls: "effecti" };
    case "linha":
      return { label: "LINHA", cls: "nomus" };
    case "global":
    default:
      return { label: "GLOBAL", cls: "" };
  }
}

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? null : n;
}

function fmtValor(v: number | null): string {
  return v == null ? "—" : String(v);
}

type Feedback = { kind: "ok" | "err"; msg: string };

/**
 * cmp-parametros-form — edita os 5 parametros escalares (impostos, frete,
 * despesas, lucro, taxa horaria) e o vetor regional (5 regioes) de um
 * nivel/escopo (GLOBAL / LINHA / PRODUTO). Override parcial: campo vazio =
 * herdar do nivel acima (PRODUTO -> LINHA -> GLOBAL). Quando ha um produto em
 * contexto (nivel produto), o badge de cada valor mostra a ORIGEM efetiva
 * (use-parametros-resolvidos), inclusive por regiao (RNF-10). Salvar dispara o
 * recalculo dos SKUs do escopo no backend; o status-pill reflete o estado.
 */
export function ParametrosForm({
  nivel,
  escopoId,
  produtoId,
}: {
  nivel: ParametroNivel;
  escopoId: string | null;
  /** Quando presente, habilita os badges de origem efetiva por valor/regiao. */
  produtoId?: string;
}) {
  const escopo = useMemo(
    () => ({ nivel, escopo_id: escopoId }),
    [nivel, escopoId],
  );
  const parametros = useParametros(escopo);
  const regional = useParametrosRegional(escopo);
  const resolvidos = useParametrosResolvidos(produtoId, {
    enabled: Boolean(produtoId),
  });
  const upsert = useUpsertParametros();
  const upsertRegional = useUpsertParametrosRegional();

  const pending = upsert.isPending || upsertRegional.isPending;

  const rawEscalar = parametros.data?.items?.[0] ?? null;
  const rawRegionalMap = useMemo(() => {
    const m = new Map<Regiao, number | null>();
    for (const r of regional.data?.items ?? []) m.set(r.regiao, r.percentual);
    return m;
  }, [regional.data]);

  const [escalares, setEscalares] = useState<Record<string, string>>({});
  const [regioes, setRegioes] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // Hidrata os campos a partir dos valores brutos do escopo (e re-hidrata ao
  // trocar de escopo ou apos salvar/refetch).
  useEffect(() => {
    const nextEsc: Record<string, string> = {};
    for (const { campo } of ESCALARES) {
      const v = rawEscalar ? rawEscalar[campo] : null;
      nextEsc[campo] = v == null ? "" : String(v);
    }
    setEscalares(nextEsc);
    const nextReg: Record<string, string> = {};
    for (const { value } of REGIOES) {
      const v = rawRegionalMap.get(value) ?? null;
      nextReg[value] = v == null ? "" : String(v);
    }
    setRegioes(nextReg);
    setFeedback(null);
  }, [rawEscalar, rawRegionalMap]);

  const podeHerdar = nivel !== "global";
  const loading = parametros.isLoading || regional.isLoading;

  async function onSave() {
    setFeedback(null);
    try {
      await upsert.mutateAsync({
        nivel,
        escopo_id: escopoId,
        impostos_pct: toNumber(escalares.impostos_pct ?? ""),
        frete_pct: toNumber(escalares.frete_pct ?? ""),
        despesas_pct: toNumber(escalares.despesas_pct ?? ""),
        lucro_pct: toNumber(escalares.lucro_pct ?? ""),
        lucro_minimo_pct: toNumber(escalares.lucro_minimo_pct ?? ""),
        taxa_horaria: toNumber(escalares.taxa_horaria ?? ""),
      });
      await upsertRegional.mutateAsync({
        nivel,
        escopo_id: escopoId,
        regioes: REGIOES.map((r) => ({
          regiao: r.value,
          percentual: toNumber(regioes[r.value] ?? ""),
        })),
      });
      setFeedback({
        kind: "ok",
        msg: "Parâmetros salvos · recálculo dos SKUs do escopo disparado.",
      });
    } catch (err) {
      setFeedback({
        kind: "err",
        msg:
          err instanceof ApiError && err.status === 400
            ? "Dados inválidos: revise os percentuais."
            : "Não foi possível salvar os parâmetros. Tente novamente.",
      });
    }
  }

  const editTag = origemTag(nivel);
  const saveDescriptor = pending
    ? ({ state: "run", label: "Salvando…" } as const)
    : feedback?.kind === "ok"
      ? ({ state: "ok", label: "Salvo" } as const)
      : feedback?.kind === "err"
        ? ({ state: "err", label: "Erro ao salvar" } as const)
        : ({ state: "idle", label: `Editando ${editTag.label}` } as const);

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 6px" }}>
        <h3>Parâmetros de custo</h3>
        <StatusPill state={saveDescriptor.state} label={saveDescriptor.label} />
      </div>
      <p style={{ margin: "0 0 16px", fontSize: "12.5px", color: "var(--muted)" }}>
        {podeHerdar
          ? "Deixe um campo em branco para herdar do nível acima (override parcial). O badge indica a origem efetiva de cada valor."
          : "Valores base do nível GLOBAL. Linhas e Produtos podem sobrescrever parcialmente."}
      </p>

      {loading ? (
        <div style={{ display: "grid", gap: 10 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <span key={i} className="skel skel-line" style={{ width: "100%" }} />
          ))}
        </div>
      ) : (
        <>
          <div className="grid-fields" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            {ESCALARES.map(({ campo, label, suffix }) => {
              const efetivo = resolvidos.data?.escalares[campo] ?? null;
              return (
                <div className="field" key={campo} style={{ marginBottom: 0 }}>
                  <label
                    htmlFor={`param-${campo}`}
                    style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}
                  >
                    <span>{label}</span>
                    {efetivo && (
                      <span className={cn("tag", origemTag(efetivo.origem).cls)}>
                        {origemTag(efetivo.origem).label}
                      </span>
                    )}
                  </label>
                  <div className="input-affix">
                    <input
                      id={`param-${campo}`}
                      type="number"
                      step="any"
                      placeholder={podeHerdar ? "herdar" : "0"}
                      value={escalares[campo] ?? ""}
                      onChange={(e) => {
                        setEscalares((prev) => ({ ...prev, [campo]: e.target.value }));
                        setFeedback(null);
                      }}
                    />
                    <span className="suffix">{suffix}</span>
                  </div>
                  {efetivo && (
                    <div className="helper">
                      Efetivo:{" "}
                      <span className="tnum">{fmtValor(efetivo.valor)}</span>
                      {suffix === "%" ? "%" : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="section-title" style={{ margin: "24px 0 13px" }}>
            <h3>Vetor regional</h3>
            <span className="count">% por região</span>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Região</th>
                  <th style={{ width: 200 }}>Percentual</th>
                  {produtoId && <th style={{ width: 180 }}>Efetivo</th>}
                </tr>
              </thead>
              <tbody>
                {REGIOES.map((r) => {
                  const efetivo = resolvidos.data?.regional[r.value] ?? null;
                  return (
                    <tr key={r.value}>
                      <td>
                        <span className="mono">{r.value}</span>
                        <span className="sub" style={{ marginLeft: 8 }}>
                          {r.label}
                        </span>
                      </td>
                      <td>
                        <div className="input-affix" style={{ maxWidth: 180 }}>
                          <input
                            type="number"
                            step="any"
                            aria-label={`Percentual da região ${r.label}`}
                            placeholder={podeHerdar ? "herdar" : "0"}
                            value={regioes[r.value] ?? ""}
                            onChange={(e) => {
                              setRegioes((prev) => ({ ...prev, [r.value]: e.target.value }));
                              setFeedback(null);
                            }}
                          />
                          <span className="suffix">%</span>
                        </div>
                      </td>
                      {produtoId && (
                        <td>
                          {efetivo ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                              <span className="tnum">{fmtValor(efetivo.percentual)}%</span>
                              <span className={cn("tag", origemTag(efetivo.origem).cls)}>
                                {origemTag(efetivo.origem).label}
                              </span>
                            </span>
                          ) : (
                            <span style={{ color: "var(--faint)" }}>—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="form-foot" style={{ marginTop: 18 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSave}
              disabled={pending}
            >
              {pending ? (
                <Loader2 className="spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              <span>{pending ? "Salvando…" : "Salvar parâmetros"}</span>
            </button>
            {feedback && (
              <span className={cn("save-note", feedback.kind === "err" && "err")}>
                {feedback.kind === "err" ? (
                  <TriangleAlert aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                {feedback.msg}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
