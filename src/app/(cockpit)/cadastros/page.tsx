import { redirect } from "next/navigation";

// Entrada do menu Cadastros: cai na primeira aba (Produtos).
export const dynamic = "force-dynamic";

export default function CadastrosPage() {
  redirect("/cadastros/produtos");
}
