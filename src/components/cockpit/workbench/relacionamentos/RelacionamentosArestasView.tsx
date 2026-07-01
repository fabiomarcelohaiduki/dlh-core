"use client";

// =====================================================================
// RelacionamentosArestasView - sub-aba "Arestas" dentro da feature
// Relacionamentos (irma da sub-aba "Grafo").
//
// Le a MESMA fonte de dados da sub-aba Grafo (`panorama.arestas`).
// Adiciona:
//   - Barra de filtros (origem/destino/relacao/metodo/confianca/busca)
//   - Tabela com 6 colunas: Origem→Destino, Relacao, Metodo, Conf., Quando, Acoes
//   - Pager simples (LIMIT 50 hardcoded; total exibido no rodape)
//
// Acoes por linha:
//   - ⌖ focar no grafo (callback cross-subaba para voltar p/ "Grafo"
//     e ja selecionar o no de origem)
//   - ⓘ detalhes (placeholder ate a feature de detalhe da aresta
//     ficar pronta — botao desabilitado por default)
//
// IMPORTANTE: zero backend novo. Tudo client-side sobre panoramaData
// que ja vem do hook useRelacionamentosPanorama.
// =====================================================================

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  ArestaVisual,
  NoVisual,
  RelacionamentoTipoNo,
} from "@/lib/api/relacionamentos-types";
import { ArestaAcoes } from "./ArestaAcoes";
import { ArestaBadge } from "./ArestaBadge";
import { ArestaConfianca } from "./ArestaConfianca";
import { ArestaOrigemDestino } from "./ArestaOrigemDestino";

// ---------------------------------------------------------------------
// Constantes.
// ---------------------------------------------------------------------

/** Tamanho da pagina (limite duro de linhas renderizadas por vez). */
const PAGE_SIZE = 50;

// ---------------------------------------------------------------------
// Tipos publicos.
// ---------------------------------------------------------------------

export interface RelacionamentosArestasViewProps {
  arestas: ArestaVisual[];
  nos: NoVisual[];
  /** Callback para focar um no no grafo (cross-subaba). */
  onFocusNo: (no: { tipo: NoVisual["tipo"]; id: string }) => void;
}

/** Estado dos filtros client-side. */
interface FiltrosEstado {
  origem_tipo: RelacionamentoTipoNo | null;
  destino_tipo: RelacionamentoTipoNo | null;
  relacao: string | null;
  metodo: string | null;
  confiancaMin: number;
  busca: string;
}

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

/** Resolve um no pelo par (tipo, id). Retorna null se nao encontrado. */
function resolverNo(
  nos: NoVisual[],
  tipo: RelacionamentoTipoNo,
  id: string,
): NoVisual | null {
  return nos.find((n) => n.tipo === tipo && n.id === id) ?? null;
}

/** Coleta os valores unicos de um campo para os pills de filtro. */
function valoresUnicos<T extends string>(
  arestas: ArestaVisual[],
  campo: "relacao" | "metodo",
): T[] {
  const set = new Set<T>();
  for (const a of arestas) set.add(a[campo] as T);
  return Array.from(set).sort();
}

/** Coleta os tipos de no presentes nas pontas (origem OU destino). */
function tiposPresentes(arestas: ArestaVisual[]): RelacionamentoTipoNo[] {
  const set = new Set<RelacionamentoTipoNo>();
  for (const a of arestas) {
    set.add(a.origem_tipo);
    set.add(a.destino_tipo);
  }
  return Array.from(set).sort();
}

/** Aplica os filtros sobre a lista de arestas. */
function aplicarFiltros(
  arestas: ArestaVisual[],
  filtros: FiltrosEstado,
  nos: NoVisual[],
): ArestaVisual[] {
  const buscaNorm = filtros.busca.trim().toLowerCase();
  return arestas.filter((a) => {
    if (filtros.origem_tipo && a.origem_tipo !== filtros.origem_tipo) return false;
    if (filtros.destino_tipo && a.destino_tipo !== filtros.destino_tipo) return false;
    if (filtros.relacao && a.relacao !== filtros.relacao) return false;
    if (filtros.metodo && a.metodo !== filtros.metodo) return false;
    if (a.confianca < filtros.confiancaMin) return false;
    if (buscaNorm) {
      // busca textual simples: confere contra relacao, metodo, label e id
      // da origem e do destino resolvidos
      const o = resolverNo(nos, a.origem_tipo, a.origem_id);
      const d = resolverNo(nos, a.destino_tipo, a.destino_id);
      const alvo = [
        a.relacao,
        a.metodo,
        o?.label ?? "",
        o?.id ?? "",
        d?.label ?? "",
        d?.id ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!alvo.includes(buscaNorm)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------
// Sub-componente: Pill de filtro (origem/destino/relacao/metodo).
// ---------------------------------------------------------------------

interface PillFiltroProps {
  /** Valor selecionado atual. null = "todos". */
  valor: string | null;
  /** Lista de opcoes (ja ordenadas). */
  opcoes: string[];
  /** Rotulo exibido antes do valor (ex.: "Origem"). */
  rotulo: string;
  /** Callback ao alterar valor. null para limpar. */
  onChange: (valor: string | null) => void;
}

function PillFiltro({ valor, opcoes, rotulo, onChange }: PillFiltroProps) {
  if (opcoes.length === 0) return null;
  const aberto = valor !== null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          // Toggle: se ja tem valor, limpa; senao, pega o primeiro disponivel.
          if (aberto) onChange(null);
          else onChange(opcoes[0]);
        }}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-3 py-1",
          "border text-[11.5px] font-medium",
          aberto
            ? "border-[color:var(--accent)] bg-[color-mix(in_oklch,var(--accent)_12%,transparent)] text-accent-strong"
            : "border-[color-mix(in_oklch,var(--fg)_12%,transparent)] bg-[color-mix(in_oklch,var(--fg)_5%,transparent)] text-muted",
          "hover:text-fg transition-colors",
        )}
        aria-pressed={aberto}
        data-pill-filtro={rotulo.toLowerCase()}
      >
        <span className="text-[10.5px] uppercase tracking-wider opacity-75">{rotulo}:</span>
        <span>{aberto ? valor : "todos"}</span>
        {aberto ? <X className="size-3" aria-hidden="true" /> : null}
      </button>
      {/* Menu simples: so aparece quando ha 2+ opcoes e nada selecionado,
          abrindo um <select> invisivel via <details> para nao pesar. */}
      {opcoes.length > 1 && !aberto ? (
        <select
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v) onChange(v);
          }}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label={`Selecionar ${rotulo.toLowerCase()}`}
        >
          <option value="">Selecionar {rotulo.toLowerCase()}</option>
          {opcoes.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function RelacionamentosArestasView({
  arestas,
  nos,
  onFocusNo,
}: RelacionamentosArestasViewProps) {
  // Estado de filtros.
  const [origemTipo, setOrigemTipo] = useState<RelacionamentoTipoNo | null>(null);
  const [destinoTipo, setDestinoTipo] = useState<RelacionamentoTipoNo | null>(null);
  const [relacao, setRelacao] = useState<string | null>(null);
  const [metodo, setMetodo] = useState<string | null>(null);
  const [confiancaMin, setConfiancaMin] = useState<number>(0);
  const [busca, setBusca] = useState<string>("");
  const [pagina, setPagina] = useState<number>(1);

  // Dados derivados.
  const tiposOrigem = useMemo(
    () => tiposPresentes(arestas), // origem e destino compartilham o mesmo universo
    [arestas],
  );
  const tiposDestino = tiposOrigem;
  const relacoes = useMemo(() => valoresUnicos<string>(arestas, "relacao"), [arestas]);
  const metodos = useMemo(() => valoresUnicos<string>(arestas, "metodo"), [arestas]);

  const arestasFiltradas = useMemo(
    () =>
      aplicarFiltros(
        arestas,
        { origem_tipo: origemTipo, destino_tipo: destinoTipo, relacao, metodo, confiancaMin, busca },
        nos,
      ),
    [arestas, origemTipo, destinoTipo, relacao, metodo, confiancaMin, busca, nos],
  );

  // Pager.
  const totalPaginas = Math.max(1, Math.ceil(arestasFiltradas.length / PAGE_SIZE));
  const paginaAtual = Math.min(pagina, totalPaginas);
  const inicio = (paginaAtual - 1) * PAGE_SIZE;
  const fim = Math.min(inicio + PAGE_SIZE, arestasFiltradas.length);
  const arestasPagina = arestasFiltradas.slice(inicio, fim);

  // Resetar pagina quando os filtros mudam.
  // (feito implicitamente via Math.min; mas tambem forcamos se passou do teto)
  if (pagina > totalPaginas) {
    setPagina(totalPaginas);
  }

  // Filtros ativos (para contagem no rodape da barra).
  const filtrosAtivos =
    Number(origemTipo !== null) +
    Number(destinoTipo !== null) +
    Number(relacao !== null) +
    Number(metodo !== null) +
    Number(confiancaMin > 0) +
    Number(busca.trim() !== "");

  return (
    <div
      data-painel-arestas
      className="flex flex-col gap-3"
    >
      {/* Barra de filtros */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-md",
          "border border-[color-mix(in_oklch,var(--fg)_10%,transparent)]",
          "bg-[color-mix(in_oklch,var(--fg)_3%,transparent)]",
          "px-3 py-2",
        )}
        data-arestas-filtros
      >
        <PillFiltro
          rotulo="Origem"
          valor={origemTipo}
          opcoes={tiposOrigem}
          onChange={(v) => setOrigemTipo((v as RelacionamentoTipoNo) ?? null)}
        />
        <PillFiltro
          rotulo="Destino"
          valor={destinoTipo}
          opcoes={tiposDestino}
          onChange={(v) => setDestinoTipo((v as RelacionamentoTipoNo) ?? null)}
        />
        <PillFiltro
          rotulo="Relacao"
          valor={relacao}
          opcoes={relacoes}
          onChange={setRelacao}
        />
        <PillFiltro
          rotulo="Metodo"
          valor={metodo}
          opcoes={metodos}
          onChange={setMetodo}
        />

        {/* Confianca minima (range 0..1, step 0.05) */}
        <label
          className={cn(
            "inline-flex items-center gap-2 rounded-full px-3 py-1",
            "border text-[11.5px] font-medium",
            confiancaMin > 0
              ? "border-[color:var(--accent)] bg-[color-mix(in_oklch,var(--accent)_12%,transparent)] text-accent-strong"
              : "border-[color-mix(in_oklch,var(--fg)_12%,transparent)] bg-[color-mix(in_oklch,var(--fg)_5%,transparent)] text-muted",
          )}
          data-pill-conf
        >
          <span className="text-[10.5px] uppercase tracking-wider opacity-75">Conf ≥</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={confiancaMin}
            onChange={(e) => setConfiancaMin(Number(e.target.value))}
            className="w-[80px] accent-[color:var(--accent)]"
            aria-label="Confianca minima"
          />
          <span className="font-variant-numeric tabular-nums">{confiancaMin.toFixed(2)}</span>
        </label>

        {/* Busca textual */}
        <label
          className={cn(
            "inline-flex min-w-[180px] flex-1 items-center gap-2 rounded-md px-2 py-1",
            "border border-[color-mix(in_oklch,var(--fg)_12%,transparent)] bg-[color-mix(in_oklch,var(--fg)_5%,transparent)]",
          )}
        >
          <Search className="size-3.5 text-muted" aria-hidden="true" />
          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar relacao, origem ou destino…"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
            data-input-busca
          />
          {busca ? (
            <button
              type="button"
              onClick={() => setBusca("")}
              aria-label="Limpar busca"
              className="text-muted hover:text-fg"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </label>

        {/* Contador */}
        <span
          className="ml-auto text-[11.5px] text-muted"
          data-contagem-arestas
        >
          {arestasFiltradas.length} aresta{arestasFiltradas.length === 1 ? "" : "s"}
          {filtrosAtivos > 0 ? (
            <> · {arestas.length} totais · {filtrosAtivos} filtro{filtrosAtivos === 1 ? "" : "s"} ativo{filtrosAtivos === 1 ? "" : "s"}</>
          ) : null}
        </span>
      </div>

      {/* Tabela */}
      <div
        className={cn(
          "overflow-hidden rounded-md",
          "border border-[color-mix(in_oklch,var(--fg)_10%,transparent)]",
          "bg-[color-mix(in_oklch,var(--fg)_3%,transparent)]",
        )}
        data-tabela-arestas
      >
        {arestasFiltradas.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-[13px] font-semibold text-fg">
              Nenhuma aresta corresponde aos filtros
            </p>
            <p className="text-[12px] text-muted">
              Ajuste os filtros acima ou limpe a busca para ver todas as {arestas.length} arestas.
            </p>
          </div>
        ) : (
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col style={{ width: "32%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "1%" }} />
            </colgroup>
            <thead>
              <tr className="border-b border-[color-mix(in_oklch,var(--fg)_10%,transparent)]">
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Origem → Destino
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Relação
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Método
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Conf.
                </th>
                <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Ações
                </th>
              </tr>
            </thead>
            <tbody>
              {arestasPagina.map((a, idx) => {
                const origem = resolverNo(nos, a.origem_tipo, a.origem_id);
                const destino = resolverNo(nos, a.destino_tipo, a.destino_id);
                // Se faltar o no (panorama truncou), pula a linha (defensivo).
                if (!origem || !destino) return null;
                return (
                  <tr
                    key={`${a.origem_tipo}:${a.origem_id}->${a.destino_tipo}:${a.destino_id}#${idx}`}
                    className={cn(
                      "border-b border-[color-mix(in_oklch,var(--fg)_6%,transparent)] last:border-b-0",
                      idx % 2 === 1 && "bg-[color-mix(in_oklch,var(--fg)_2%,transparent)]",
                      "hover:bg-[color-mix(in_oklch,var(--fg)_6%,transparent)]",
                    )}
                    data-linha-aresta
                  >
                    <td className="px-3 py-2 align-middle">
                      <ArestaOrigemDestino origem={origem} destino={destino} />
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <ArestaBadge variant="relacao">{a.relacao}</ArestaBadge>
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <ArestaBadge
                        variant={
                          a.metodo === "deterministico"
                            ? "metodo-determin"
                            : "metodo-embedding"
                        }
                      >
                        {a.metodo}
                      </ArestaBadge>
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <ArestaConfianca value={a.confianca} />
                    </td>
                    <td className="px-3 py-2 align-middle text-right">
                      <ArestaAcoes
                        onFocus={() => onFocusNo({ tipo: origem.tipo, id: origem.id })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Pager */}
        {arestasFiltradas.length > PAGE_SIZE ? (
          <div
            className={cn(
              "flex items-center justify-between border-t border-[color-mix(in_oklch,var(--fg)_10%,transparent)]",
              "px-3 py-2 text-[11.5px] text-muted",
            )}
            data-pager-arestas
          >
            <span>
              Mostrando <strong className="text-fg">{inicio + 1}–{fim}</strong> de{" "}
              <strong className="text-fg">{arestasFiltradas.length}</strong>
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                disabled={paginaAtual <= 1}
                onClick={() => setPagina((p) => Math.max(1, p - 1))}
                className="rounded-md border border-[color-mix(in_oklch,var(--fg)_12%,transparent)] bg-[color-mix(in_oklch,var(--fg)_5%,transparent)] px-2 py-1 disabled:opacity-40"
              >
                ‹
              </button>
              <span className="px-1">
                Pagina <strong className="text-fg">{paginaAtual}</strong> de{" "}
                <strong className="text-fg">{totalPaginas}</strong>
              </span>
              <button
                type="button"
                disabled={paginaAtual >= totalPaginas}
                onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
                className="rounded-md border border-[color-mix(in_oklch,var(--fg)_12%,transparent)] bg-[color-mix(in_oklch,var(--fg)_5%,transparent)] px-2 py-1 disabled:opacity-40"
              >
                ›
              </button>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}