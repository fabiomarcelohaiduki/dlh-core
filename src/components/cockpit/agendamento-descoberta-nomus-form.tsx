"use client";

import { useSalvarAgendamentoDescobertaNomus } from "@/hooks/use-admin";
import { AgendamentoCronForm } from "@/components/cockpit/agendamento-cron-form";
import type { AgendamentoExtracaoState } from "@/lib/api/types";

/**
 * cmp-agendamento-descoberta-nomus-form — Agendamento da DESCOBERTA
 * (enfileiramento) do Nomus.
 *
 * Na hora marcada, o pg_cron 'descobrir-nomus' chama a Edge documentos-descobrir
 * (server-side, sem PC) que varre nomus_processos e materializa os anexos
 * pendentes em documento_vinculos — enchendo a fila de extracao. So o Nomus tem
 * relogio proprio: Effecti auto-descobre pos-coleta e Gmail/Drive entregam a
 * lista na coleta. Reusa o relogio generico AgendamentoCronForm; salvar
 * reescreve o pg_cron via PUT /descoberta-agendamento. O botao manual "Trazer
 * para a fila" (guia Fila de extração) segue como atalho.
 */
export function AgendamentoDescobertaNomusForm({
  initial,
}: {
  initial: AgendamentoExtracaoState;
}) {
  const salvar = useSalvarAgendamentoDescobertaNomus();
  return (
    <AgendamentoCronForm
      initial={initial}
      salvar={salvar}
      ativoLabel="Enfileiramento automático ligado"
      helperFrequencia="Com que frequência o cockpit descobre e enfileira os anexos do Nomus."
      defaultHorario="06:00"
      okMessageOn="Agendamento salvo · enfileiramento automático ligado"
      okMessageOff="Agendamento salvo · enfileiramento automático desligado"
    />
  );
}
