import type { AvisoDetalhe } from "@/lib/api/types";

/**
 * Estados travados de uma etapa do pipeline (cmp-pipeline):
 *  done  = etapa concluida com sucesso
 *  error = etapa falhou (ponto de investigacao)
 *  skip  = etapa nao executada (fronteira de escopo da Fase 1)
 */
export type PipelineStepState = "done" | "error" | "skip";

export interface PipelineStep {
  id: string;
  label: string;
  detail: string;
  state: PipelineStepState;
  /** Fronteira de escopo: etapa sem acao executavel na Fase 1 (delta-004). */
  outOfScope?: boolean;
}

function pluralizar(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * derivePipeline — deriva as etapas Coleta -> Tratamento -> Indexacao ->
 * Persistencia a partir do detalhe do aviso, mais a etapa de Enriquecimento
 * cognitivo como 'nao executada na Fase 1' (US-06/US-09, delta-004).
 *
 * A derivacao usa apenas o detalhe persistido, garantindo que o deep-link
 * direto (sem o erro de origem) produza o mesmo pipeline.
 */
export function derivePipeline(detalhe: AvisoDetalhe): PipelineStep[] {
  const { indice } = detalhe;
  const arquivos = indice.arquivos ?? [];
  const chunks = indice.chunks ?? [];

  // Tratamento: falha se algum arquivo ficou com tratamento em erro.
  const tratamentoErro = arquivos.some((a) => a.statusTratamento === "erro");
  const temVerbatim = detalhe.conteudoVerbatim.trim().length > 0;
  const tratamentoState: PipelineStepState = tratamentoErro
    ? "error"
    : temVerbatim || arquivos.length > 0
      ? "done"
      : "skip";

  // Indexacao: derivada do status persistido + presenca de chunks.
  const statusIndex = indice.statusIndexacao;
  let indexState: PipelineStepState;
  let indexDetail: string;
  if (statusIndex === "erro") {
    indexState = "error";
    indexDetail = "Falha na geração de embeddings";
  } else if (statusIndex === "indexado") {
    indexState = "done";
    indexDetail = chunks.length > 0 ? pluralizar(chunks.length, "chunk", "chunks") : "Índice gerado";
  } else if (statusIndex === "em_andamento") {
    indexState = "done";
    indexDetail = "Indexação em andamento";
  } else {
    // Sem status: usa a presenca de chunks como evidencia.
    indexState = chunks.length > 0 ? "done" : "skip";
    indexDetail = chunks.length > 0 ? pluralizar(chunks.length, "chunk", "chunks") : "Não indexado";
  }

  return [
    {
      id: "coleta",
      label: "Coletado",
      detail: "Persistido via conector",
      state: "done",
    },
    {
      id: "tratamento",
      label: "Tratado",
      detail: tratamentoErro
        ? "Falha na extração do edital"
        : arquivos.length > 0
          ? `${pluralizar(arquivos.length, "arquivo", "arquivos")} · verbatim`
          : "Verbatim extraído",
      state: tratamentoState,
    },
    {
      id: "indexacao",
      label: "Indexação",
      detail: indexDetail,
      state: indexState,
    },
    {
      id: "persistencia",
      label: "Persistência",
      detail: "Supabase · íntegro",
      state: "done",
    },
    {
      id: "enriquecimento",
      label: "Enriquecimento",
      detail: "Fase 2 — não executado na Fase 1",
      state: "skip",
      outOfScope: true,
    },
  ];
}
