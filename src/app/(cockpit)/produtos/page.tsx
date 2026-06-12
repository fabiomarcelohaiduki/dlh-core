import type { Metadata } from "next";
import { ProdutosClient } from "./produtos-client";

export const metadata: Metadata = { title: "Linhas & Produtos" };

export default function ProdutosPage() {
  return <ProdutosClient />;
}
