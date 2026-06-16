import { redirect } from "next/navigation";

// Entrada do menu Ingestão: cai na primeira aba (Execução).
export const dynamic = "force-dynamic";

export default function IngestaoPage() {
  redirect("/ingestao/execucoes");
}
