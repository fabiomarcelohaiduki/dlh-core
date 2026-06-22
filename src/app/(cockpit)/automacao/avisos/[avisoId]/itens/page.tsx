import type { Metadata } from "next";
import { ListaItensExtraidos } from "@/components/automacao/lista-itens-extraidos";

// Superficie acessada a partir da linha de um aviso (Triagem/Fila/Lixeira).
// Os metadados do cabecalho (orgao/UF/edital/Effecti) chegam por query da
// propria linha; o deep-link direto funciona mostrando so o identificador.
export const metadata: Metadata = {
  title: "Lista de itens extraídos",
  robots: { index: false, follow: false },
};

export default async function ListaItensPage({
  params,
  searchParams,
}: {
  params: Promise<{ avisoId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { avisoId } = await params;
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return (
    <ListaItensExtraidos
      avisoId={avisoId}
      meta={{
        orgao: str(sp.orgao),
        uf: str(sp.uf),
        edital: str(sp.edital),
        effecti: str(sp.effecti),
      }}
    />
  );
}
