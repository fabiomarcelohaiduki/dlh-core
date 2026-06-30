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
  loadConfigIndexacao,
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
    configIndexacao,
  ] = await Promise.all([
    loadAgendamentosColeta(),
    loadEscopoColeta(),
    loadNomusConfigurado(),
    loadConfigExtracao(),
    loadAgendamentoExtracao(),
    loadAgendamentoDescobertaNomus(),
    loadConfigIndexacao(),
  ]);
  return (
    <ColetaClient
      agendamentos={agendamentos}
      escopo={escopo}
      nomusConfigurado={nomusConfigurado}
      configExtracao={configExtracao}
      agendamentoExtracao={agendamentoExtracao}
      agendamentoDescobertaNomus={agendamentoDescobertaNomus}
      configIndexacao={configIndexacao}
    />
  );
}
