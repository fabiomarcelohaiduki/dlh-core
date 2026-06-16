"use client";

import { useState } from "react";
import { ExtracaoPanel } from "@/components/cockpit/extracao-panel";
import { ExtracaoConfigForm } from "@/components/cockpit/extracao-config-form";
import { AgendamentoExtracaoForm } from "@/components/cockpit/agendamento-extracao-form";
import { AgendamentoOcrForm } from "@/components/cockpit/agendamento-ocr-form";
import { ExtracaoDisparoForm } from "@/components/cockpit/extracao-disparo-form";
import type { AgendamentoExtracaoState, ConfigExtracaoState } from "@/lib/api/types";
import { cn } from "@/lib/utils";

type Aba = "operacao" | "parametros";

/**
 * cmp-extracao-tabs — Reune as duas telas de extracao num so lugar (pedido do
 * Fabio): a aba "Operação" e o painel de fila/disparo (ex-/extracao); a aba
 * "Parâmetros" e a antiga tela /extracao-config (agendamentos + config da
 * camada 1). Mesmo padrao de abas segmented/role=tablist do detalhe de produto.
 *
 * Os dados de config (singleton config_extracao) sao hidratados server-side na
 * page e descem por props; o painel de operacao busca os proprios dados via
 * hooks (React Query).
 */
export function ExtracaoTabs({
  nomusConfigurado = false,
  configExtracao,
  agendamentoExtracao,
  agendamentoOcr,
}: {
  nomusConfigurado?: boolean;
  configExtracao: ConfigExtracaoState;
  agendamentoExtracao: AgendamentoExtracaoState;
  agendamentoOcr: AgendamentoExtracaoState;
}) {
  const [aba, setAba] = useState<Aba>("operacao");

  return (
    <>
      <div
        className="filter-group segmented"
        role="tablist"
        aria-label="Seção da extração"
        style={{ display: "inline-flex", margin: "4px 0 16px" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={aba === "operacao"}
          className={cn("btn", "btn-sm", aba === "operacao" && "btn-primary")}
          onClick={() => setAba("operacao")}
        >
          Operação
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === "parametros"}
          className={cn("btn", "btn-sm", aba === "parametros" && "btn-primary")}
          onClick={() => setAba("parametros")}
        >
          Parâmetros
        </button>
      </div>

      {aba === "operacao" ? (
        <ExtracaoPanel nomusConfigurado={nomusConfigurado} />
      ) : (
        <>
          <div className="extracao-acoes-row">
            <AgendamentoExtracaoForm initial={agendamentoExtracao} />
            <AgendamentoOcrForm initial={agendamentoOcr} />
            <ExtracaoDisparoForm />
          </div>

          <ExtracaoConfigForm initial={configExtracao} />
        </>
      )}
    </>
  );
}
