import type { Metadata } from "next";
import { ExecucoesClient } from "@/app/(cockpit)/execucoes/execucoes-client";

export const metadata: Metadata = { title: "Coleta" };

export default function IngestaoColetaPage() {
  return <ExecucoesClient />;
}
