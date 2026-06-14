"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { useApoioPrecos } from "@/hooks/use-apoio-precos";
import { usePrecosCalculados } from "@/hooks/use-precos-calculados";
import { ApiError } from "@/lib/api/client";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PrecoApoio } from "@/lib/api/types";

/** Converte um input de texto em number|null (vazio -> null). */
function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? null : n;
}

/**
 * cmp-apoio-precos-form — captura manual dos indicadores de apoio do SKU
 * (preco_concorrencia, custo_ideal): os UNICOS campos gravaveis do grid
 * (RF-23). valor, custo_base e ifp vem do motor e ficam somente leitura
 * (o ifp e calculado por celula em fn_recalcular_sku). Compartilha o cache de
 * usePrecosCalculados com o grid e hidrata o form a partir de `apoio`.
 */
export function ApoioPrecosForm({ skuId }: { skuId: string }) {
  const precos = usePrecosCalculados(skuId);
  const apoioPrecos = useApoioPrecos();

  const [precoConcorrencia, setPrecoConcorrencia] = useState("");
  const [custoIdeal, setCustoIdeal] = useState("");
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );

  const apoio = precos.data?.apoio;
  const custoBase = precos.data?.custo_base ?? null;

  // Hidrata o form quando o apoio carrega ou troca de SKU.
  useEffect(() => {
    setPrecoConcorrencia(
      apoio?.preco_concorrencia != null ? String(apoio.preco_concorrencia) : "",
    );
    setCustoIdeal(apoio?.custo_ideal != null ? String(apoio.custo_ideal) : "");
    setFeedback(null);
  }, [apoio]);

  async function onSave() {
    setFeedback(null);
    const payload: PrecoApoio = {
      preco_concorrencia: toNumber(precoConcorrencia),
      custo_ideal: toNumber(custoIdeal),
    };
    try {
      await apoioPrecos.mutateAsync({ skuId, apoio: payload });
      setFeedback({ kind: "ok", msg: "Indicadores salvos." });
    } catch (err) {
      setFeedback({
        kind: "err",
        msg:
          err instanceof ApiError && err.status === 400
            ? "Valores inválidos: revise os indicadores."
            : "Não foi possível salvar os indicadores.",
      });
    }
  }

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Indicadores de apoio</h3>
      </div>

      {precos.isLoading ? (
        <span className="skel skel-line" style={{ width: "70%" }} />
      ) : (
        <>
          <div className="grid-fields" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="apoio-concorrencia">Preço concorrência</label>
              <input
                id="apoio-concorrencia"
                type="number"
                step="any"
                placeholder="Opcional"
                value={precoConcorrencia}
                onChange={(e) => setPrecoConcorrencia(e.target.value)}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="apoio-custo-ideal">Custo ideal</label>
              <input
                id="apoio-custo-ideal"
                type="number"
                step="any"
                placeholder="Opcional"
                value={custoIdeal}
                onChange={(e) => setCustoIdeal(e.target.value)}
              />
            </div>
          </div>

          <div className="field" style={{ marginTop: 14, marginBottom: 0, maxWidth: 260 }}>
            <label htmlFor="apoio-custo-base">Custo base (motor)</label>
            <input
              id="apoio-custo-base"
              type="text"
              value={formatCurrency(custoBase)}
              readOnly
              disabled
            />
            <div className="helper">Somente leitura — calculado pelo motor.</div>
          </div>

          <div className="form-foot" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSave}
              disabled={apoioPrecos.isPending}
            >
              {apoioPrecos.isPending ? (
                <Loader2 className="spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              <span>{apoioPrecos.isPending ? "Salvando…" : "Salvar indicadores"}</span>
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
