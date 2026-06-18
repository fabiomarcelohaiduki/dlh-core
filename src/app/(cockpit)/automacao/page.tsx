import { redirect } from "next/navigation";

// Entrada do menu Automação: cai na primeira aba (Fila).
export const dynamic = "force-dynamic";

export default function AutomacaoPage() {
  redirect("/automacao/fila");
}
