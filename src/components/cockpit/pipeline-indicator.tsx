import { Check, X, Sparkles } from "lucide-react";
import type { PipelineStep, PipelineStepState } from "@/lib/pipeline";

const STATE_CLASS: Record<PipelineStepState, string> = {
  done: "done",
  error: "error",
  skip: "skip",
};

function StepIcon({ state }: { state: PipelineStepState }) {
  if (state === "done") return <Check aria-hidden="true" />;
  if (state === "error") return <X aria-hidden="true" />;
  // skip — etapa nao executada na Fase 1 (ex.: enriquecimento cognitivo).
  return <Sparkles aria-hidden="true" />;
}

/**
 * cmp-pipeline — Pipeline do item (Coleta -> Tratamento -> Indexação ->
 * Persistência) nos estados done/error/skip. A etapa de Enriquecimento
 * cognitivo aparece como 'não executada na Fase 1', sem ação executável
 * (fronteira de escopo, delta-004 / US-06 / US-09).
 *
 * Componente puramente apresentacional: recebe as etapas ja derivadas do
 * detalhe (lib/pipeline.derivePipeline) — assim o deep-link direto produz o
 * mesmo pipeline sem depender do erro de origem.
 */
export function PipelineIndicator({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="pipeline" role="list" aria-label="Pipeline do item">
      {steps.map((step) => (
        <div
          key={step.id}
          className={`pstep ${STATE_CLASS[step.state]}`}
          role="listitem"
          aria-label={`${step.label}: ${step.detail}`}
        >
          <span className="ic">
            <StepIcon state={step.state} />
          </span>
          <div className="pt">
            <b>{step.label}</b>
            <span>{step.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
