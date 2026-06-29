import type { Metadata } from "next";
import { ExtracaoView } from "@/components/cockpit/extracao-view";
import {
  loadAgendamentoExtracao,
  loadConfigExtracao,
  loadNomusConfigurado,
} from "@/lib/extracao-config-data";

export const metadata: Metadata = { title: "Extração" };

export default async function IngestaoExtracaoPage() {
  const [nomusConfigurado, configExtracao, agendamentoExtracao] =
    await Promise.all([
      loadNomusConfigurado(),
      loadConfigExtracao(),
      loadAgendamentoExtracao(),
    ]);

  return (
    <ExtracaoView
      nomusConfigurado={nomusConfigurado}
      configExtracao={configExtracao}
      agendamentoExtracao={agendamentoExtracao}
    />
  );
}
