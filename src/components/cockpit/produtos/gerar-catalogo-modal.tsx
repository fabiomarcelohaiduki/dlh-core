"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { GerarDocumentoModal } from "@/components/cockpit/produtos/gerar-documento-modal";
import type { ProdutoLinha, Regiao } from "@/lib/api/types";

const REGIOES: { value: Regiao; label: string }[] = [
  { value: "S", label: "Sul" },
  { value: "SE", label: "Sudeste" },
  { value: "CO", label: "Centro-Oeste" },
  { value: "NE", label: "Nordeste" },
  { value: "N", label: "Norte" },
];

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * cmp-gerar-catalogo-modal — seletor que precede a geracao do PDF de catalogo.
 * Escolhe quais Linhas e Produtos entram; ao gerar, abre a rota de impressao em
 * nova aba. O catalogo distribui os produtos em cards (grade 2 colunas) ao longo
 * das paginas, mostrando so os atributos marcados como "aparece no catalogo".
 * Opcionalmente inclui os precos regionais por SKU (CIF Minimo - CIF Alvo).
 * Fina casca sobre o seletor compartilhado, acrescentando os campos de preco.
 */
export function GerarCatalogoModal({
  linhas,
  onClose,
}: {
  linhas: ProdutoLinha[];
  onClose: () => void;
}) {
  const [incluirPrecos, setIncluirPrecos] = useState(false);
  const [regioesSel, setRegioesSel] = useState<Set<Regiao>>(
    new Set<Regiao>(REGIOES.map((r) => r.value)),
  );

  // Precos so entram quando o toggle esta ligado E ha ao menos uma regiao.
  const extraValido = !incluirPrecos || regioesSel.size > 0;
  const extraParams: Record<string, string> = {};
  if (incluirPrecos && regioesSel.size > 0) {
    extraParams.precos = "1";
    extraParams.regioes = REGIOES.filter((r) => regioesSel.has(r.value))
      .map((r) => r.value)
      .join(",");
  }

  return (
    <GerarDocumentoModal
      titulo="Gerar catálogo"
      helper="Cada produto vira um card. Aparecem apenas os atributos marcados como visíveis no catálogo."
      rota="/produtos/catalogo/imprimir"
      linhas={linhas}
      onClose={onClose}
      extraParams={extraParams}
      extraValido={extraValido}
      cardStyle={{ boxShadow: "var(--shadow-overlay)" }}
    >
      <div className="field">
        <label>Preços</label>
        <div className="chk-grid" role="group" aria-label="Preços">
          <label className={cn("chk", incluirPrecos && "on")}>
            <input
              type="checkbox"
              checked={incluirPrecos}
              onChange={() => setIncluirPrecos((v) => !v)}
            />
            <div className="t">Incluir preços por região (Mínimo – Alvo)</div>
          </label>
        </div>
        {incluirPrecos ? (
          <>
            <div
              className="chk-grid"
              role="group"
              aria-label="Regiões"
              style={{ marginTop: 8 }}
            >
              {REGIOES.map((r) => {
                const on = regioesSel.has(r.value);
                return (
                  <label key={r.value} className={cn("chk", on && "on")}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setRegioesSel((s) => toggle(s, r.value))}
                    />
                    <div className="t">{r.label}</div>
                  </label>
                );
              })}
            </div>
            <div className="helper">
              Cada SKU mostra o intervalo CIF Mínimo – CIF Alvo nas regiões
              selecionadas. Selecione ao menos uma região.
            </div>
          </>
        ) : null}
      </div>
    </GerarDocumentoModal>
  );
}
