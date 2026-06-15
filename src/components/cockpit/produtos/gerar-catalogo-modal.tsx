"use client";

import { GerarDocumentoModal } from "@/components/cockpit/produtos/gerar-documento-modal";
import type { ProdutoLinha } from "@/lib/api/types";

/**
 * cmp-gerar-catalogo-modal — seletor que precede a geracao do PDF de catalogo.
 * Escolhe quais Linhas e Produtos entram; ao gerar, abre a rota de impressao em
 * nova aba. O catalogo distribui os produtos em cards (grade 2 colunas) ao longo
 * das paginas, mostrando so os atributos marcados como "aparece no catalogo".
 * Sem preco. Fina casca sobre o seletor compartilhado.
 */
export function GerarCatalogoModal({
  linhas,
  onClose,
}: {
  linhas: ProdutoLinha[];
  onClose: () => void;
}) {
  return (
    <GerarDocumentoModal
      titulo="Gerar catálogo"
      helper="Cada produto vira um card. Aparecem apenas os atributos marcados como visíveis no catálogo."
      rota="/produtos/catalogo/imprimir"
      linhas={linhas}
      onClose={onClose}
    />
  );
}
