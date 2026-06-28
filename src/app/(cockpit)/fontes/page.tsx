import { redirect } from "next/navigation";

// Rota legada: redireciona em runtime, sem prerender estatico (o redirect
// nao tem HTML para gerar no build).
export const dynamic = "force-dynamic";

/**
 * As fontes e credenciais agora vivem em Integrações (bloco "Conectores de
 * ingestão"). Esta rota legada redireciona para o novo lugar.
 */
export default function FontesPage() {
  redirect("/integracoes-global");
}
