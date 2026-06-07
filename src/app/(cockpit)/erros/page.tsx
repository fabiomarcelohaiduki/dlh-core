import type { Metadata } from "next";
import { ErrosClient } from "./erros-client";

export const metadata: Metadata = {
  title: "Erros",
  description:
    "Erros de ingestão por etapa (coleta, tratamento e indexação) com navegação para investigação do edital.",
};

export default function ErrosPage() {
  return <ErrosClient />;
}
