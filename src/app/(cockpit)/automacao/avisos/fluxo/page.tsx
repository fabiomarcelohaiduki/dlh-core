import type { Metadata } from "next";
import { FluxoClient } from "./fluxo-client";

export const metadata: Metadata = { title: "Como funciona" };

export default function FluxoPage() {
  return <FluxoClient />;
}
