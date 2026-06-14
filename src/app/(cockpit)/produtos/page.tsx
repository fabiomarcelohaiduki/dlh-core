import type { Metadata } from "next";
import { ProdutosClient } from "./produtos-client";

export const metadata: Metadata = { title: "Linha de produtos" };

export default function ProdutosPage() {
  return <ProdutosClient />;
}
