import { redirect } from "next/navigation";

// Rota legada: redireciona em runtime, sem prerender estatico (o redirect
// nao tem HTML para gerar no build).
export const dynamic = "force-dynamic";

/**
 * Os parâmetros de extração agora vivem na Coleta (/ingestao/coleta): o
 * agendamento na guia "Agendamento" e a config na guia "Fila de extração"
 * (botão "Parâmetros"). Esta rota legada redireciona para lá.
 */
export default function ExtracaoConfigPage() {
  redirect("/ingestao/coleta");
}
