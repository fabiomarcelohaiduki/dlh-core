import type { Metadata } from "next";
import { ColetaClient } from "@/components/cockpit/workbench/coleta-client";

export const metadata: Metadata = { title: "Coleta" };

export default function IngestaoColetaPage() {
  return <ColetaClient />;
}
