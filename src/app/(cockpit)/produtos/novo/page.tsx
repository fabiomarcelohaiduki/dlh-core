import type { Metadata } from "next";
import { CadastroWizard } from "@/components/cockpit/produtos/cadastro-wizard";

export const metadata: Metadata = {
  title: "Cadastro guiado",
  robots: { index: false, follow: false },
};

export default function NovoProdutoPage() {
  return <CadastroWizard />;
}
