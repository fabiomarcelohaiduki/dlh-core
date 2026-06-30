import { redirect } from "next/navigation";

// Rota legada: redireciona em runtime, sem prerender estatico (o redirect
// nao tem HTML para gerar no build).
export const dynamic = "force-dynamic";

/**
 * Os parâmetros agora vivem na Coleta (/ingestao/coleta): agendamento na guia
 * "Agendamento" e config na guia "Fila de extração" (botão "Parâmetros"). Esta
 * rota legada redireciona para lá.
 */
export default function IngestaoConfiguracaoPage() {
  redirect("/ingestao/coleta");
}
