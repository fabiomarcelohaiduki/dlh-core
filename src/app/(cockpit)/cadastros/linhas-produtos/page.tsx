import type { Metadata } from "next";
import { LinhasProdutosClient } from "@/components/cockpit/workbench/linhas-produtos-client";

export const metadata: Metadata = { title: "Linhas de produtos" };

export default function CadastrosLinhasProdutosPage() {
  return <LinhasProdutosClient />;
}
