import type { Metadata } from "next";
import { ExecucoesClient } from "@/app/(cockpit)/execucoes/execucoes-client";

export const metadata: Metadata = { title: "Coleta" };

export default function IngestaoExecucoesPage() {
  return <ExecucoesClient />;
}
