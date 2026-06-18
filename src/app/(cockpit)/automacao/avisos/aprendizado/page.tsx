import type { Metadata } from "next";
import { AprendizadoClient } from "./aprendizado-client";

export const metadata: Metadata = { title: "Aprendizado" };

export default function AprendizadoPage() {
  return <AprendizadoClient />;
}
