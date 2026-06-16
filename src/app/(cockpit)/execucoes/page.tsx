import { redirect } from "next/navigation";

// Rota legada: redireciona em runtime, sem prerender estatico (o redirect
// nao tem HTML para gerar no build).
export const dynamic = "force-dynamic";

/**
 * As execuções agora vivem dentro do menu Ingestão (aba "Execução"). Esta
 * rota legada redireciona para o novo lugar.
 */
export default function ExecucoesPage() {
  redirect("/ingestao/execucoes");
}
