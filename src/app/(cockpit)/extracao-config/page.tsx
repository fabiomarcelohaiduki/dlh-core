import { redirect } from "next/navigation";

// Rota legada: redireciona em runtime, sem prerender estatico (o redirect
// nao tem HTML para gerar no build).
export const dynamic = "force-dynamic";

/**
 * A configuração de extração agora vive dentro do menu Ingestão (aba
 * "Configuração de extração"). Esta rota legada redireciona para o novo lugar.
 */
export default function ExtracaoConfigPage() {
  redirect("/ingestao/configuracao");
}
