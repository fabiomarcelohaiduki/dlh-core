"use client";

import { useState } from "react";
import { Check, Loader2, RefreshCw, Sparkles, TriangleAlert, X } from "lucide-react";
import { useCreateDiretriz } from "@/hooks/use-criterios";
import { ApiError } from "@/lib/api/client";
import {
  gerarTermosLinha,
  reindexarProdutos,
  type GerarTermosLinhaResposta,
} from "@/lib/api/produtos";
import type { CotacaoNivel } from "@/lib/api/types";

/** Item de preview generico (linha/produto/sku) com rotulo e texto sugerido. */
interface ItemSugestao {
  key: string;
  nivel: CotacaoNivel;
  escopoId: string;
  rotulo: string;
  texto: string;
}

/**
 * cmp-termos-linha-card — botao "Gerar termos com a Lia" para uma Linha
 * inteira. A IA analisa a Linha + Produtos + SKUs e sugere os Termos de busca
 * (vocabulario de recall) por nivel. A IA SUGERE; cada sugestao cai num preview
 * e so vira diretriz (cotacao_diretrizes) quando o usuario aplica item a item.
 * Aplicar nao reindexa: avisa que e preciso reindexar os SKUs para valer na busca.
 */
export function TermosLinhaCard({
  linhaId,
  linhaNome,
}: {
  linhaId: string;
  linhaNome: string;
}) {
  const createDiretriz = useCreateDiretriz();

  const [gerando, setGerando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [sugestao, setSugestao] = useState<GerarTermosLinhaResposta | null>(null);
  // Estado por item: pendente | aplicado | descartado (chave = `${nivel}:${id}`).
  const [estados, setEstados] = useState<Record<string, "pending" | "applying" | "applied" | "dismissed">>({});
  const [algoAplicado, setAlgoAplicado] = useState(false);

  const [reindexando, setReindexando] = useState(false);
  const [reindexFeedback, setReindexFeedback] = useState<
    { kind: "ok" | "err"; message: string } | null
  >(null);

  async function onGerar() {
    setErro(null);
    setSugestao(null);
    setEstados({});
    setAlgoAplicado(false);
    setGerando(true);
    try {
      const resposta = await gerarTermosLinha(linhaId);
      setSugestao(resposta);
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 503
          ? "Geração indisponível: configure e ative a IA em Configurações da empresa."
          : "Não foi possível gerar os termos. Tente novamente.",
      );
    } finally {
      setGerando(false);
    }
  }

  async function aplicar(item: ItemSugestao) {
    setEstados((s) => ({ ...s, [item.key]: "applying" }));
    try {
      await createDiretriz.mutateAsync({
        nivel: item.nivel,
        escopo_id: item.escopoId,
        texto: item.texto,
      });
      setEstados((s) => ({ ...s, [item.key]: "applied" }));
      setAlgoAplicado(true);
    } catch {
      setEstados((s) => ({ ...s, [item.key]: "pending" }));
      setErro("Não foi possível aplicar o termo. Tente novamente.");
    }
  }

  function descartar(key: string) {
    setEstados((s) => ({ ...s, [key]: "dismissed" }));
  }

  async function onReindexar() {
    if (reindexando) return;
    setReindexFeedback(null);
    setReindexando(true);
    try {
      const r = await reindexarProdutos(linhaId);
      setReindexFeedback({
        kind: "ok",
        message: `Índice atualizado · ${r.indexados} SKU(s) reindexado(s).`,
      });
      setAlgoAplicado(false);
    } catch (err) {
      setReindexFeedback({
        kind: "err",
        message:
          err instanceof ApiError && err.status === 503
            ? "Reindexação indisponível: configure e ative a IA em Configurações da empresa."
            : "Não foi possível reindexar. Tente novamente.",
      });
    } finally {
      setReindexando(false);
    }
  }

  // Achata a sugestao numa lista ordenada (linha -> produtos -> skus).
  const itens: ItemSugestao[] = [];
  if (sugestao?.linha) {
    itens.push({
      key: `linha:${sugestao.linha.escopo_id}`,
      nivel: "linha",
      escopoId: sugestao.linha.escopo_id,
      rotulo: `Linha · ${sugestao.linha.nome}`,
      texto: sugestao.linha.texto,
    });
  }
  for (const p of sugestao?.produtos ?? []) {
    itens.push({
      key: `produto:${p.escopo_id}`,
      nivel: "produto",
      escopoId: p.escopo_id,
      rotulo: `Produto · ${p.nome}`,
      texto: p.texto,
    });
  }
  for (const s of sugestao?.skus ?? []) {
    itens.push({
      key: `sku:${s.escopo_id}`,
      nivel: "sku",
      escopoId: s.escopo_id,
      rotulo: `SKU · ${s.codigo_sku} (${s.produto_nome})`,
      texto: s.texto,
    });
  }

  const visiveis = itens.filter((i) => estados[i.key] !== "dismissed");
  const semSugestao = sugestao !== null && itens.length === 0;

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 4px" }}>
        <h3>Termos de busca da linha</h3>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          style={{ marginLeft: "auto" }}
          onClick={onGerar}
          disabled={gerando}
          title="A Lia analisa a linha, os produtos e os SKUs e sugere os termos de busca"
        >
          {gerando ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Sparkles aria-hidden="true" />
          )}
          <span>{gerando ? "Gerando…" : "Gerar termos com a Lia"}</span>
        </button>
      </div>
      <p className="sub" style={{ margin: "0 0 12px" }}>
        A Lia lê a linha <strong>{linhaNome}</strong>, seus produtos e SKUs e sugere o
        vocabulário que ajuda a encontrar cada item no edital. Você revisa e aplica
        item a item; nada é salvo sem sua confirmação.
      </p>

      {erro && (
        <div className="err-msg" style={{ display: "flex" }}>
          <TriangleAlert aria-hidden="true" />
          {erro}
        </div>
      )}

      {semSugestao && (
        <p className="sub" style={{ margin: 0 }}>
          A Lia não sugeriu novos termos para esta linha.
        </p>
      )}

      {visiveis.length > 0 && (
        <div style={{ display: "grid", gap: 10 }}>
          {visiveis.map((item) => {
            const estado = estados[item.key] ?? "pending";
            const aplicado = estado === "applied";
            const aplicando = estado === "applying";
            return (
              <div
                key={item.key}
                className="card"
                style={{ padding: 12, display: "grid", gap: 8 }}
              >
                <span className="sub">{item.rotulo}</span>
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{item.texto}</p>
                {aplicado ? (
                  <span
                    className="sub"
                    style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ok)" }}
                  >
                    <Check aria-hidden="true" />
                    Aplicado
                  </span>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => aplicar(item)}
                      disabled={aplicando}
                    >
                      {aplicando ? (
                        <Loader2 className="spin" aria-hidden="true" />
                      ) : (
                        <Check aria-hidden="true" />
                      )}
                      <span>{aplicando ? "Aplicando…" : "Aplicar"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => descartar(item.key)}
                      disabled={aplicando}
                    >
                      <X aria-hidden="true" />
                      <span>Descartar</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div
        style={{
          marginTop: 14,
          paddingTop: 14,
          borderTop: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className={algoAplicado ? "btn btn-sm btn-primary" : "btn btn-sm"}
          onClick={onReindexar}
          disabled={reindexando}
          title="Recalcula a busca semântica dos SKUs desta linha (necessário após alterar termos)"
        >
          {reindexando ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          <span>{reindexando ? "Reindexando…" : "Reindexar busca da linha"}</span>
        </button>
        {algoAplicado && !reindexFeedback && (
          <span className="sub">
            Termos aplicados. Reindexe para que entrem na busca.
          </span>
        )}
        {reindexFeedback && (
          <span
            className="sub"
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: reindexFeedback.kind === "err" ? "var(--err)" : "var(--ok)",
            }}
          >
            {reindexFeedback.kind === "err" ? (
              <TriangleAlert aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {reindexFeedback.message}
          </span>
        )}
      </div>
    </div>
  );
}
