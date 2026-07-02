"use client";

// =====================================================================
// RelacionamentosPainel - container da Sub-tab "Relacionamentos" da
// view de Coleta (Ingestao).
//
// Container com 4 sub-abas. As sub-views entregues:
//   - A. Grafo                          (panorama + vizinhanca)
//   - B. Regras humanas                 (catalogo_regras_vinculo)
//   - C. Regras inferidas pela Lia      (vinculos_inferidos_lia)
//   - E. Parametros                     (config_relacionamentos +
//                                        config_tipos_no)
//
// F1: a sub-aba "Aprovacoes pendentes" foi removida - o workflow de
// aprovacao deu lugar ao feedback inline visto/incorreta nas arestas.
// F5: a view correspondente foi esvaziada (tombstone), aguardando
// remocao fisica do arquivo pelo revisor.
//
// Sub-aba default: "Grafo" (A), conforme SPEC.
// =====================================================================

import { useState } from "react";
import { Tabs } from "@/components/ui/tabs";
import { ToastProvider } from "@/components/ui/toast";
import { RelacionamentosGrafoView } from "./RelacionamentosGrafoView";
import { RelacionamentosRegrasView } from "./RelacionamentosRegrasView";
import { RelacionamentosVinculosLiaView } from "./RelacionamentosVinculosLiaView";
import { RelacionamentosRegrasSemanticasView } from "./RelacionamentosRegrasSemanticasView";

/** Tipo das sub-abas internas. Mantido estrito (string union). */
type Subaba = "grafo" | "regras-humanas" | "regras-lia" | "regras-semanticas";

/** Lista canonica das sub-abas. */
const SUBABAS: ReadonlyArray<{ value: Subaba; label: string }> = [
  { value: "grafo", label: "Grafo" },
  { value: "regras-humanas", label: "Regras humanas" },
  { value: "regras-lia", label: "Regras inferidas pela Lia" },
  { value: "regras-semanticas", label: "Regras semânticas" },
];

/** Container com 5 sub-abas e views proprias. */
export function RelacionamentosPainel() {
  const [subaba, setSubaba] = useState<Subaba>("grafo");

  return (
    <ToastProvider>
      <section
        data-painel="relacionamentos"
        data-subaba-ativa={subaba}
        className="flex flex-col gap-4"
      >
        <header className="flex flex-col gap-1">
          <h2 className="text-[15px] font-semibold text-fg">Relacionamentos</h2>
          <p className="text-[12.5px] text-muted">
            Explore o grafo de nos/arestas da org, gerencie o catalogo de regras humanas,
            revise os vinculos inferidos pela Lia e ajuste os parametros de promocao.
          </p>
        </header>

        <Tabs<Subaba>
          ariaLabel="Sub-abas de Relacionamentos"
          value={subaba}
          onValueChange={setSubaba}
          items={SUBABAS}
        />

        {subaba === "grafo" ? <RelacionamentosGrafoView /> : null}
        {subaba === "regras-humanas" ? <RelacionamentosRegrasView /> : null}
        {subaba === "regras-lia" ? <RelacionamentosVinculosLiaView /> : null}
        {subaba === "regras-semanticas" ? <RelacionamentosRegrasSemanticasView /> : null}
      </section>
    </ToastProvider>
  );
}
