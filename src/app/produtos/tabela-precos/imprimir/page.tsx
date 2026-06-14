import { Suspense } from "react";
import type { Metadata } from "next";
import { TabelaPrecosImpressao } from "@/components/cockpit/produtos/tabela-precos-impressao";

export const metadata: Metadata = { title: "Tabela de preços" };

export default function TabelaPrecosImprimirPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40 }}>Carregando…</div>}>
      <TabelaPrecosImpressao />
    </Suspense>
  );
}
