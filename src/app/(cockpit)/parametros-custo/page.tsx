import type { Metadata } from "next";
import { ParametrosCustoPanel } from "@/components/cockpit/produtos/parametros-custo-panel";

export const metadata: Metadata = { title: "Parâmetros de custo" };

export default function ParametrosCustoPage() {
  return (
    <section className="screen">
      <ParametrosCustoPanel />
    </section>
  );
}
