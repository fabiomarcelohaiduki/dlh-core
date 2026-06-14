import { Suspense } from "react";
import type { Metadata } from "next";
import { CatalogoImpressao } from "@/components/cockpit/produtos/catalogo-impressao";

export const metadata: Metadata = { title: "Catálogo" };

export default function CatalogoImprimirPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40 }}>Carregando…</div>}>
      <CatalogoImpressao />
    </Suspense>
  );
}
