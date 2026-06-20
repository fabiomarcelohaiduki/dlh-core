"use client";

import { useMemo, useState } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import type { AvisoItem, AvisoItemMatch, MatchFeedbackInput } from "@/lib/api/types";
import { useProdutos } from "@/hooks/use-produtos";
import { useLinhas } from "@/hooks/use-linhas";
import { useProdutoSkus, useSendMatchFeedback } from "@/hooks/use-match-feedback";

/**
 * cmp-match-feedback-panel — Painel inline de correcao do match (item x
 * produto/SKU). UNICO componente para os 3 casos:
 *   - sem match  -> "adicionar" (escolher produto + SKU)
 *   - com match  -> "corrigir" (trocar produto e/ou SKU) ou "tirar" (remover)
 * Captura para a fila de aprendizado (padrao SOM: nao reprocessa). Seletor de
 * produto agrupado por linha (catalogo pequeno); SKU dependente do produto.
 */
export function MatchFeedbackPanel({
  avisoId,
  item,
  match,
  onClose,
  onSaved,
}: {
  avisoId: string;
  item: AvisoItem;
  match: AvisoItemMatch | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const temMatch = match != null;
  const [produtoId, setProdutoId] = useState<string | null>(match?.produtoId ?? null);
  const [skuId, setSkuId] = useState<string | null>(match?.skuId ?? null);
  const [motivo, setMotivo] = useState("");

  const linhas = useLinhas({ ativo: true, limit: 200 });
  const produtos = useProdutos({ ativo: true });
  const skus = useProdutoSkus(produtoId);
  const enviar = useSendMatchFeedback(avisoId);

  // Produtos agrupados por linha para o <select> com <optgroup>.
  const grupos = useMemo(() => {
    const porLinha = new Map<string, { nome: string; produtos: { id: string; nome: string }[] }>();
    const nomeLinha = new Map<string, string>(
      (linhas.data?.items ?? []).map((l) => [l.id, l.nome]),
    );
    for (const p of produtos.data?.items ?? []) {
      const g = porLinha.get(p.linha_id) ?? {
        nome: nomeLinha.get(p.linha_id) ?? "Sem linha",
        produtos: [],
      };
      g.produtos.push({ id: p.id, nome: p.nome });
      porLinha.set(p.linha_id, g);
    }
    return [...porLinha.values()].sort((a, b) => a.nome.localeCompare(b.nome));
  }, [linhas.data, produtos.data]);

  const motivoVazio = motivo.trim().length === 0;
  const pending = enviar.isPending;

  function handleProduto(value: string) {
    setProdutoId(value || null);
    setSkuId(null); // troca de produto reseta o SKU (lista dependente muda).
  }

  function salvar() {
    if (motivoVazio || !produtoId) return;
    const input: MatchFeedbackInput = {
      avisoId,
      documentoItemId: item.id,
      acao: temMatch ? "corrigir" : "adicionar",
      itemDescricao: item.descricao,
      produtoSugeridoId: match?.produtoId ?? null,
      skuSugeridoId: match?.skuId ?? null,
      produtoSugeridoNome: match?.produtoNome ?? null,
      produtoCorretoId: produtoId,
      skuCorretoId: skuId,
      motivo: motivo.trim(),
    };
    enviar.mutate(input, {
      onSuccess: () => {
        onSaved(temMatch ? "Correção registrada." : "Match adicionado.");
        onClose();
      },
      onError: () => onSaved("Erro ao salvar. Tente novamente."),
    });
  }

  function tirar() {
    if (motivoVazio) return;
    enviar.mutate(
      {
        avisoId,
        documentoItemId: item.id,
        acao: "remover",
        itemDescricao: item.descricao,
        produtoSugeridoId: match?.produtoId ?? null,
        skuSugeridoId: match?.skuId ?? null,
        produtoSugeridoNome: match?.produtoNome ?? null,
        motivo: motivo.trim(),
      },
      {
        onSuccess: () => {
          onSaved("Match removido.");
          onClose();
        },
        onError: () => onSaved("Erro ao salvar. Tente novamente."),
      },
    );
  }

  const produtoSelId = `mf-produto-${item.id}`;
  const skuSelId = `mf-sku-${item.id}`;
  const motivoId = `mf-motivo-${item.id}`;

  return (
    <div className="cell-stack" style={{ gap: 10, padding: "10px 0" }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div className="field" style={{ marginBottom: 0, minWidth: 240 }}>
          <label htmlFor={produtoSelId}>Produto certo</label>
          <select
            id={produtoSelId}
            value={produtoId ?? ""}
            disabled={pending || produtos.isLoading}
            onChange={(e) => handleProduto(e.target.value)}
          >
            <option value="">Selecione o produto…</option>
            {grupos.map((g) => (
              <optgroup key={g.nome} label={g.nome}>
                {g.produtos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nome}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="field" style={{ marginBottom: 0, minWidth: 220 }}>
          <label htmlFor={skuSelId}>SKU certo</label>
          <select
            id={skuSelId}
            value={skuId ?? ""}
            disabled={pending || !produtoId || skus.isLoading}
            onChange={(e) => setSkuId(e.target.value || null)}
          >
            <option value="">{produtoId ? "Selecione o SKU…" : "Escolha o produto antes"}</option>
            {(skus.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.codigo_sku}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={motivoId}>Por que o match estava errado?</label>
        <textarea
          id={motivoId}
          rows={2}
          placeholder="Ex.: o edital pede 380mm, o certo é o disco 380 e não o 350."
          value={motivo}
          disabled={pending}
          onChange={(e) => setMotivo(e.target.value)}
        />
      </div>

      <div className="action-col" role="group" aria-label="Salvar correção do match">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={pending || motivoVazio || !produtoId}
          onClick={salvar}
        >
          {pending ? <Loader2 className="spin" aria-hidden="true" /> : null}
          {temMatch ? "Salvar correção" : "Salvar match"}
        </button>
        {temMatch ? (
          <button
            type="button"
            className="btn btn-sm"
            style={{ color: "var(--err)" }}
            disabled={pending || motivoVazio}
            onClick={tirar}
            title={motivoVazio ? "Escreva o motivo antes" : undefined}
          >
            <Trash2 aria-hidden="true" />
            Tirar match
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" disabled={pending} onClick={onClose}>
          <X aria-hidden="true" />
          Cancelar
        </button>
      </div>
    </div>
  );
}
