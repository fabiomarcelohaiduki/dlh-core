import { redirect } from "next/navigation";

// Rota legada: redireciona em runtime, sem prerender estatico (o redirect
// nao tem HTML para gerar no build).
export const dynamic = "force-dynamic";

/**
 * Os parametros de extracao foram movidos para dentro da tela de Extração
 * (aba "Parâmetros"). Esta rota legada redireciona para o novo lugar.
 */
export default function ExtracaoConfigPage() {
  redirect("/extracao");
}
