import type { Metadata } from "next";
import { ConfigClient } from "./config-client";

export const metadata: Metadata = { title: "Configuração" };

export default function ConfigPage() {
  return <ConfigClient />;
}
