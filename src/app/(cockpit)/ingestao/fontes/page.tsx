import { redirect } from "next/navigation";

// Rota legada: redireciona em runtime, sem prerender estatico (o redirect
// nao tem HTML para gerar no build).
export const dynamic = "force-dynamic";

/**
 * As fontes e credenciais saíram do menu Ingestão e agora vivem em Integrações
 * (bloco "Conectores de ingestão"). Esta rota legada redireciona para lá.
 */
export default function IngestaoFontesPage() {
  redirect("/integracoes-global");
}
