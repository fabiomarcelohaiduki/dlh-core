import type { Metadata } from "next";
import { AvisosClient } from "./avisos-client";

export const metadata: Metadata = { title: "Triagem" };

export default function AvisosPage() {
  return <AvisosClient />;
}
