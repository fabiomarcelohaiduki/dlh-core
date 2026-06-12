import type { Metadata } from "next";
import { ParametrosCustoClient } from "./parametros-custo-client";

export const metadata: Metadata = { title: "Parâmetros de custo" };

export default function ParametrosCustoPage() {
  return <ParametrosCustoClient />;
}
