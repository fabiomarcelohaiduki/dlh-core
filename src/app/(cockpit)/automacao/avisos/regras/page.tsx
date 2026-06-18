import type { Metadata } from "next";
import { RegrasClient } from "./regras-client";

export const metadata: Metadata = { title: "Regras" };

export default function RegrasPage() {
  return <RegrasClient />;
}
