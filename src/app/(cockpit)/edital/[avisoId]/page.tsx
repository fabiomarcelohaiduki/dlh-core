import type { Metadata } from "next";
import { EditalClient } from "./edital-client";

// Superficie nao navegavel (sem item de menu, sem listagem): o acesso humano
// ocorre somente a partir de um erro do Monitoramento (US-14/RF-24). O deep-link
// direto funciona se o usuario estiver autorizado (RLS), mas nao deve ser
// indexado nem listado.
export const metadata: Metadata = {
  title: "Detalhe do edital",
  robots: { index: false, follow: false },
};

export default async function EditalPage({
  params,
}: {
  params: Promise<{ avisoId: string }>;
}) {
  const { avisoId } = await params;
  return <EditalClient avisoId={avisoId} />;
}
