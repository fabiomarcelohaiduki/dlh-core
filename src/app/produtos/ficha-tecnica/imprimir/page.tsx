import { Suspense } from "react";
import type { Metadata } from "next";
import { FichaImpressao } from "@/components/cockpit/produtos/ficha-impressao";

export const metadata: Metadata = { title: "Ficha técnica" };

export default function FichaTecnicaImprimirPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40 }}>Carregando…</div>}>
      <FichaImpressao />
    </Suspense>
  );
}
