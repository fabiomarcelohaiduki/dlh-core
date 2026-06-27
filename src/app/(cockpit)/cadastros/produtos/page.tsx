import type { Metadata } from "next";
import { ProdutosClient } from "@/components/cockpit/workbench/produtos-client";

export const metadata: Metadata = { title: "Produtos" };

export default function CadastrosProdutosPage() {
  return <ProdutosClient />;
}
