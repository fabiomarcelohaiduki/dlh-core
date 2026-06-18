import type { Metadata } from "next";
import { FilaPanel } from "@/components/automacao/fila-panel";

export const metadata: Metadata = { title: "Fila" };

export default function FilaPage() {
  return <FilaPanel />;
}
