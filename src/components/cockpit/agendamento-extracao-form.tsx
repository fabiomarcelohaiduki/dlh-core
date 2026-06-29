"use client";

import { useSalvarAgendamentoExtracao } from "@/hooks/use-admin";
import { AgendamentoCronForm } from "@/components/cockpit/agendamento-cron-form";
import type { AgendamentoExtracaoState } from "@/lib/api/types";

/**
 * cmp-agendamento-extracao-form — Agendamento da EXTRACAO (Tika/OCR).
 *
 * O extrator e GLOBAL (drena a fila inteira, multi-fonte): um unico relogio
 * (job pg_cron 'extrair-anexos'). Pos-migracao local (28/06), na hora marcada o
 * pg_cron ENFILEIRA o comando 'tika-ocr' na fila comando_local e o PC roda
 * extrair-tika.ps1 (extracao rapida + OCR juntos). Reusa o relogio generico
 * AgendamentoCronForm; salvar reescreve o pg_cron via PUT /extracao-agendamento.
 */
export function AgendamentoExtracaoForm({ initial }: { initial: AgendamentoExtracaoState }) {
  const salvar = useSalvarAgendamentoExtracao();
  return (
    <AgendamentoCronForm
      initial={initial}
      salvar={salvar}
      ativoLabel="Extração automática ligada"
      helperFrequencia="Com que frequência o extrator drena a fila."
      defaultHorario="23:00"
      okMessageOn="Agendamento salvo · extração automática ligada"
      okMessageOff="Agendamento salvo · extração automática desligada"
    />
  );
}
