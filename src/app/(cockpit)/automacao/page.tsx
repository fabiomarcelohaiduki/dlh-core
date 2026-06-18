import { redirect } from "next/navigation";

// Entrada do menu Automação: cai na primeira aba (Triagem).
export const dynamic = "force-dynamic";

export default function AutomacaoPage() {
  redirect("/automacao/avisos");
}
