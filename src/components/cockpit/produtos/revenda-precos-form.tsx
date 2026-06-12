"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus, Tag, TriangleAlert, Trash2 } from "lucide-react";
import {
  useCreateRevendaPreco,
  useDeleteRevendaPreco,
  useRevendaPrecos,
} from "@/hooks/use-revenda";
import { useProdutos } from "@/hooks/use-produtos";
import { useProduto } from "@/hooks/use-produto";
import { ApiError } from "@/lib/api/client";
import { StatusPill } from "@/components/cockpit/status-pill";
import { formatCurrency, formatDate } from "@/lib/format";
import type { RevendaPreco } from "@/lib/api/types";

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? null : n;
}

function hojeISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isVigente(p: RevendaPreco, hoje: string): boolean {
  if (p.vigencia_inicio > hoje) return false;
  return p.vigencia_fim == null || p.vigencia_fim >= hoje;
}

/**
 * cmp-revenda-precos-form — tabela de precos de revenda por cliente/SKU. O SKU
 * e escolhido via Produto -> SKU (nao ha lista global de SKUs). Para o par
 * cliente/SKU exibe o historico de vigencia (a faixa vigente fica destacada e
 * com status-pill) e um formulario que cria NOVA faixa preservando o historico
 * (POST). Canal SEPARADO do preco de licitacao.
 */
export function RevendaPrecosForm({ clienteId }: { clienteId: string }) {
  const produtos = useProdutos({ limit: 500 });
  const [produtoId, setProdutoId] = useState("");
  const [skuId, setSkuId] = useState("");

  const detalhe = useProduto(produtoId || undefined, {
    enabled: Boolean(produtoId),
  });
  const skus = detalhe.data?.skus ?? [];
  const produtoItems = produtos.data?.items ?? [];

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Tabela de preços de revenda</h3>
        <span className="count">canal separado</span>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: "12.5px", color: "var(--muted)" }}>
        Selecione um Produto e um SKU para gerir os preços de revenda deste
        cliente. Cada nova faixa preserva o histórico de vigência — sem se
        misturar com o preço de licitação.
      </p>

      <div className="grid-fields" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="revenda-produto">Produto</label>
          <select
            id="revenda-produto"
            value={produtoId}
            onChange={(e) => {
              setProdutoId(e.target.value);
              setSkuId("");
            }}
            disabled={produtos.isLoading}
          >
            <option value="">Selecione um produto…</option>
            {produtoItems.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="revenda-sku">SKU</label>
          <select
            id="revenda-sku"
            value={skuId}
            onChange={(e) => setSkuId(e.target.value)}
            disabled={!produtoId || detalhe.isLoading || skus.length === 0}
          >
            <option value="">
              {!produtoId
                ? "Escolha um produto primeiro"
                : detalhe.isLoading
                  ? "Carregando…"
                  : skus.length === 0
                    ? "Nenhum SKU neste produto"
                    : "Selecione um SKU…"}
            </option>
            {skus.map((s) => (
              <option key={s.id} value={s.id}>
                {s.codigo_sku} (
                {s.tipo_origem === "fabricado" ? "fabricado" : "comprado"})
              </option>
            ))}
          </select>
        </div>
      </div>

      {skuId ? (
        <RevendaPrecoSku clienteId={clienteId} skuId={skuId} />
      ) : (
        <div className="empty" style={{ paddingTop: 36, paddingBottom: 16 }}>
          <Tag aria-hidden="true" />
          <h4>Nenhum SKU selecionado</h4>
          <p>Escolha um Produto e um SKU acima para ver e editar os preços de revenda.</p>
        </div>
      )}
    </div>
  );
}

/** Historico de vigencia + nova faixa de preco para um par cliente/SKU. */
function RevendaPrecoSku({
  clienteId,
  skuId,
}: {
  clienteId: string;
  skuId: string;
}) {
  const historico = useRevendaPrecos(clienteId, {
    sku_id: skuId,
    historico: true,
  });
  const criar = useCreateRevendaPreco();
  const remover = useDeleteRevendaPreco();

  const hoje = useMemo(() => hojeISO(), []);
  const items = useMemo(() => historico.data?.items ?? [], [historico.data]);
  const vigente = useMemo(
    () => items.find((p) => isVigente(p, hoje)) ?? null,
    [items, hoje],
  );

  const [preco, setPreco] = useState("");
  const [inicio, setInicio] = useState(hoje);
  const [fim, setFim] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function onCriar() {
    setErro(null);
    const precoNum = toNumber(preco);
    if (precoNum == null || precoNum < 0) {
      setErro("Informe um preço válido.");
      return;
    }
    if (!inicio) {
      setErro("Informe o início da vigência.");
      return;
    }
    if (fim && fim < inicio) {
      setErro("O fim da vigência não pode ser anterior ao início.");
      return;
    }
    try {
      await criar.mutateAsync({
        clienteId,
        input: {
          sku_id: skuId,
          preco: precoNum,
          vigencia_inicio: inicio,
          vigencia_fim: fim ? fim : null,
        },
      });
      setPreco("");
      setInicio(hoje);
      setFim("");
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 400
          ? "Dados inválidos: revise o preço e as datas."
          : "Não foi possível adicionar a faixa. Tente novamente.",
      );
    }
  }

  async function onRemove(item: RevendaPreco) {
    setRemovingId(item.id);
    setErro(null);
    try {
      await remover.mutateAsync(item.id);
    } catch {
      setErro("Não foi possível remover a faixa. Tente novamente.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-title" style={{ margin: "0 0 13px" }}>
        <h3>Histórico de preços</h3>
        {vigente ? (
          <StatusPill state="ok" label={`Vigente ${formatCurrency(vigente.preco)}`} />
        ) : (
          <StatusPill state="warn" label="Sem preço vigente" />
        )}
      </div>

      {historico.isLoading ? (
        <div style={{ display: "grid", gap: 8 }}>
          {Array.from({ length: 2 }).map((_, i) => (
            <span key={i} className="skel skel-line" style={{ width: "100%" }} />
          ))}
        </div>
      ) : historico.isError ? (
        <div className="empty">
          <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
          <h4>Não foi possível carregar o histórico</h4>
          <p>Tente novamente em instantes.</p>
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => historico.refetch()}
            >
              Tentar novamente
            </button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <Tag aria-hidden="true" />
          <h4>Nenhum preço de revenda</h4>
          <p>Adicione a primeira faixa de vigência para este cliente/SKU.</p>
        </div>
      ) : (
        <div className="tbl-wrap tbl-scroll">
          <table>
            <thead>
              <tr>
                <th style={{ width: 150 }}>Preço</th>
                <th style={{ width: 120 }}>Início</th>
                <th style={{ width: 120 }}>Fim</th>
                <th style={{ width: 110 }}>Vigência</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const v = isVigente(p, hoje);
                return (
                  <tr
                    key={p.id}
                    style={v ? { background: "var(--accent-soft)" } : undefined}
                  >
                    <td className="tnum">{formatCurrency(p.preco)}</td>
                    <td className="mono">{formatDate(p.vigencia_inicio)}</td>
                    <td className="mono">
                      {p.vigencia_fim ? formatDate(p.vigencia_fim) : "—"}
                    </td>
                    <td>
                      {v ? (
                        <StatusPill state="ok" label="Vigente" />
                      ) : (
                        <span style={{ color: "var(--faint)" }}>—</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => onRemove(p)}
                        disabled={removingId === p.id}
                        aria-label="Remover faixa de preço"
                      >
                        {removingId === p.id ? (
                          <Loader2 className="spin" aria-hidden="true" />
                        ) : (
                          <Trash2 aria-hidden="true" />
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-title" style={{ margin: "24px 0 13px" }}>
        <h3>Nova faixa de preço</h3>
      </div>
      <div
        className="grid-fields"
        style={{
          gridTemplateColumns: "150px 140px 140px auto",
          alignItems: "end",
          gap: 12,
        }}
      >
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="revenda-preco">Preço</label>
          <input
            id="revenda-preco"
            type="number"
            step="any"
            min={0}
            placeholder="0,00"
            value={preco}
            onChange={(e) => {
              setPreco(e.target.value);
              setErro(null);
            }}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="revenda-inicio">Início</label>
          <input
            id="revenda-inicio"
            type="date"
            value={inicio}
            onChange={(e) => {
              setInicio(e.target.value);
              setErro(null);
            }}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="revenda-fim">Fim</label>
          <input
            id="revenda-fim"
            type="date"
            value={fim}
            onChange={(e) => {
              setFim(e.target.value);
              setErro(null);
            }}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCriar}
          disabled={criar.isPending}
        >
          {criar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Plus aria-hidden="true" />
          )}
          <span>Adicionar</span>
        </button>
      </div>
      <div className="helper" style={{ marginTop: 8 }}>
        Deixe o fim em branco para uma vigência aberta.
      </div>
      {erro && (
        <div className="err-msg" style={{ display: "flex", marginTop: 12 }}>
          <TriangleAlert aria-hidden="true" />
          {erro}
        </div>
      )}
    </div>
  );
}
