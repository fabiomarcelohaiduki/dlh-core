"use client";

import { useState } from "react";
import Link from "next/link";
import { Inbox, Search, ShieldAlert } from "lucide-react";
import { useBacktestRecall } from "@/hooks/use-backtest-recall";
import type { BacktestParams } from "@/lib/api/automacao";
import { ApiError } from "@/lib/api/client";
import { BacktestRecallPanel } from "@/components/automacao/backtest-recall-panel";
import { FalsoDescarteTable } from "@/components/automacao/falso-descarte-table";
import { WidgetError } from "@/components/cockpit/widget-error";

const MS_PER_DAY = 86_400_000;
const JANELA_DEFAULT_DIAS = 90;

/** Date -> "YYYY-MM-DD" para inputs e query (ISO8601 date, alinhado ao backend). */
function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * BacktestClient — aba Backtest. Materializa o gate de recall em modo sombra:
 * seletor de periodo (desde/ate), painel de cards de recall e tabela de
 * falso-descarte cruzando os vereditos da triagem contra processos reais do
 * Nomus. Somente leitura: o frontend NAO liga o descarte fisico (isso vive na
 * aba Configuracao). Estados travados: Nomus indisponivel (502, recall null),
 * empty (sem processo casado), WidgetError em falha e skeleton no fetch.
 */
export function BacktestClient() {
  const [desde, setDesde] = useState(() =>
    toISODate(new Date(Date.now() - JANELA_DEFAULT_DIAS * MS_PER_DAY)),
  );
  const [ate, setAte] = useState(() => toISODate(new Date()));
  // Periodo efetivamente consultado: so muda ao confirmar (operacao pesada).
  const [params, setParams] = useState<BacktestParams>(() => ({
    desde: toISODate(new Date(Date.now() - JANELA_DEFAULT_DIAS * MS_PER_DAY)),
    ate: toISODate(new Date()),
  }));

  const backtest = useBacktestRecall(params);

  const data = backtest.data;
  const fetching = backtest.isFetching;
  // Nomus indisponivel: a borda responde 502 (recall null). Distinto de falha
  // generica para exibir a copy especifica e nao um WidgetError cru.
  const isNomusError =
    backtest.error instanceof ApiError && backtest.error.status === 502;
  const isOtherError = backtest.isError && !isNomusError;
  const semCasados = backtest.isSuccess && (data?.casadosComAviso ?? 0) === 0;

  function aplicarPeriodo() {
    setParams({ desde, ate });
  }

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Backtest de recall</h3>
      </div>

      <p className="helper" style={{ marginTop: 2, marginBottom: 16 }}>
        Mede o recall da triagem em modo sombra, cruzando os vereditos
        preservados contra os processos reais do Nomus. Nada é descartado: é só
        a aferição antes de ligar o descarte físico.
      </p>

      {/* Gate visual (US-16): so se liga o descarte fisico depois de aferir aqui. */}
      <div className="banner" role="note">
        <ShieldAlert aria-hidden="true" />
        <div>
          <b>Gate de recall</b>
          <p>
            Confirme um recall aceitável antes de ligar o descarte físico na aba{" "}
            <Link href="/automacao/avisos/config" className="link">
              Configuração
            </Link>
            .
          </p>
        </div>
      </div>

      {/* Seletor de periodo: operacao pesada, so consulta ao confirmar. */}
      <div className="filter-bar">
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Desde</span>
          <input
            type="date"
            value={desde}
            max={ate}
            onChange={(e) => setDesde(e.target.value)}
            style={{ width: 170 }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Até</span>
          <input
            type="date"
            value={ate}
            min={desde}
            onChange={(e) => setAte(e.target.value)}
            style={{ width: 170 }}
          />
        </label>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          style={{ alignSelf: "flex-end" }}
          disabled={fetching}
          onClick={aplicarPeriodo}
        >
          <Search aria-hidden="true" />
          <span>Calcular recall</span>
        </button>
      </div>

      {isNomusError ? (
        <WidgetError
          title="Nomus indisponível"
          message="Não foi possível ler os processos do Nomus."
          onRetry={() => backtest.refetch()}
        />
      ) : isOtherError ? (
        <WidgetError
          title="Não foi possível carregar"
          message="Não foi possível calcular o backtest. Tente novamente."
          onRetry={() => backtest.refetch()}
        />
      ) : (
        <>
          <BacktestRecallPanel data={data} loading={fetching} />

          <div className="section-title">
            <h3>Falso-descarte</h3>
            {!fetching && data ? (
              <span className="count">{data.amostrasFalsoDescarte.length}</span>
            ) : null}
          </div>

          {semCasados && !fetching ? (
            <div className="tbl-wrap">
              <div className="empty">
                <Inbox aria-hidden="true" />
                <h4>Nenhum processo casado no período.</h4>
                <p>
                  Não há processo real do Nomus cruzado com aviso triado nesta
                  janela. Amplie o período para aferir o recall.
                </p>
              </div>
            </div>
          ) : (
            <FalsoDescarteTable
              items={data?.amostrasFalsoDescarte ?? []}
              loading={fetching}
            />
          )}
        </>
      )}
    </>
  );
}
