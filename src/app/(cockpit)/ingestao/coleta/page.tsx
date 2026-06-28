import type { Metadata } from "next";
import { ColetaClient } from "@/components/cockpit/workbench/coleta-client";
import {
  loadAgendamentosColeta,
  loadEscopoColeta,
} from "@/lib/fontes-credenciais-data";

export const metadata: Metadata = { title: "Coleta" };

export default async function IngestaoColetaPage() {
  const [agendamentos, escopo] = await Promise.all([
    loadAgendamentosColeta(),
    loadEscopoColeta(),
  ]);
  return <ColetaClient agendamentos={agendamentos} escopo={escopo} />;
}
