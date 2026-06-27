"use client";

import { GerarDocumentoModal } from "@/components/cockpit/produtos/gerar-documento-modal";
import type { ProdutoLinha } from "@/lib/api/types";

/**
 * cmp-gerar-ficha-modal — seletor que precede a geracao do PDF de fichas
 * tecnicas. Escolhe quais Linhas e Produtos entram; ao gerar, abre a rota de
 * impressao em nova aba. Cada SKU dos produtos escolhidos vira uma ficha (uma
 * por pagina) com todos os dados e os atributos marcados como "aparece na ficha
 * tecnica". Sem preco. Fina casca sobre o seletor compartilhado.
 */
export function GerarFichaModal({
  linhas,
  onClose,
}: {
  linhas: ProdutoLinha[];
  onClose: () => void;
}) {
  return (
    <GerarDocumentoModal
      titulo="Gerar ficha técnica"
      helper="Cada SKU vira uma ficha em página própria. Aparecem apenas os atributos marcados como visíveis na ficha técnica."
      rota="/produtos/ficha-tecnica/imprimir"
      linhas={linhas}
      onClose={onClose}
      cardStyle={{ boxShadow: "var(--shadow-overlay)" }}
    />
  );
}
