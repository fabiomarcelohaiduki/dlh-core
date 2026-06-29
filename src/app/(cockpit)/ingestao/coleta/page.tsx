import type { Metadata } from "next";
import { ColetaClient } from "@/components/cockpit/workbench/coleta-client";
import {
  loadAgendamentosColeta,
  loadEscopoColeta,
} from "@/lib/fontes-credenciais-data";
import {
  loadAgendamentoDescobertaNomus,
  loadAgendamentoExtracao,
  loadConfigExtracao,
  loadNomusConfigurado,
} from "@/lib/extracao-config-data";

export const metadata: Metadata = { title: "Coleta" };

export default async function IngestaoColetaPage() {
  const [
    agendamentos,
    escopo,
    nomusConfigurado,
    configExtracao,
    agendamentoExtracao,
    agendamentoDescobertaNomus,
  ] = await Promise.all([
    loadAgendamentosColeta(),
    loadEscopoColeta(),
    loadNomusConfigurado(),
    loadConfigExtracao(),
    loadAgendamentoExtracao(),
    loadAgendamentoDescobertaNomus(),
  ]);
  return (
    <ColetaClient
      agendamentos={agendamentos}
      escopo={escopo}
      nomusConfigurado={nomusConfigurado}
      configExtracao={configExtracao}
      agendamentoExtracao={agendamentoExtracao}
      agendamentoDescobertaNomus={agendamentoDescobertaNomus}
    />
  );
}
