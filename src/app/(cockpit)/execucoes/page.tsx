import type { Metadata } from "next";
import { ExecucoesClient } from "./execucoes-client";

export const metadata: Metadata = { title: "Execuções" };

export default function ExecucoesPage() {
  return <ExecucoesClient />;
}
