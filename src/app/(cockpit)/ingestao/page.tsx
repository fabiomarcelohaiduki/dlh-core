import { redirect } from "next/navigation";

// A configuracao da ingestao passou a viver DENTRO de Fontes e credenciais
// (vinculada a fonte). Esta rota legada redireciona para /fontes para nao
// quebrar deep-links/bookmarks antigos.
export default function IngestaoPage() {
  redirect("/fontes");
}
