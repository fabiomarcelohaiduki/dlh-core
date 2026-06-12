import type { Metadata } from "next";
import { InsumosClient } from "./insumos-client";

export const metadata: Metadata = { title: "Insumos & Preços" };

export default function InsumosPage() {
  return <InsumosClient />;
}
