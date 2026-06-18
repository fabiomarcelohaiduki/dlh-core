import type { Metadata } from "next";
import { LixeiraClient } from "./lixeira-client";

export const metadata: Metadata = { title: "Lixeira" };

export default function LixeiraPage() {
  return <LixeiraClient />;
}
