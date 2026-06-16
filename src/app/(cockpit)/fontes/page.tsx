import { redirect } from "next/navigation";

// Rota legada: redireciona em runtime, sem prerender estatico (o redirect
// nao tem HTML para gerar no build).
export const dynamic = "force-dynamic";

/**
 * As fontes e credenciais agora vivem dentro do menu Ingestão (aba
 * "Fontes e credenciais"). Esta rota legada redireciona para o novo lugar.
 */
export default function FontesPage() {
  redirect("/ingestao/fontes");
}
