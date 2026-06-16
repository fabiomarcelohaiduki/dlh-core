import { redirect } from "next/navigation";

// Rota legada: redireciona em runtime, sem prerender estatico (o redirect
// nao tem HTML para gerar no build).
export const dynamic = "force-dynamic";

/**
 * Os parâmetros agora vivem dentro da aba Extração (botão "Parâmetros" abre o
 * drawer lateral). Esta rota redireciona para lá.
 */
export default function IngestaoConfiguracaoPage() {
  redirect("/ingestao/extracao");
}
