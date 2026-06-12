import type { Metadata } from "next";
import { ProdutoDetalheClient } from "./produto-detalhe-client";

export const metadata: Metadata = {
  title: "Detalhe do produto",
  robots: { index: false, follow: false },
};

export default async function ProdutoDetalhePage({
  params,
}: {
  params: Promise<{ produtoId: string }>;
}) {
  const { produtoId } = await params;
  return <ProdutoDetalheClient produtoId={produtoId} />;
}
