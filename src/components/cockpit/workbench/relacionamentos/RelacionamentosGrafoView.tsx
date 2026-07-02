"use client";

// =====================================================================
// RelacionamentosGrafoView - container da Sub-aba A "Grafo" da feature
// de Relacionamentos.
//
// Orquestra: GrafoCanvas + GrafoPainelLateral + GrafoLegenda +
// GrafoBuscaInline + GrafoToolbar. Gerencia estados:
//
//   - loading inicial: skeleton com 3 retangulos arredondados
//   - error: toast com mensagem + codigo do backend + botao "Tentar novamente"
//   - empty (sem arestas confirmadas): "Nenhuma aresta confirmada ainda"
//   - truncado (cap por grafo excedido): aviso explicito no canto
//   - reprocessamento: spinner no botao + toast com resumo
//
// Dados:
//   - Panorama via useRelacionamentosPanorama
//   - Vizinhanca via useRelacionamentosVizinhanca (ao selecionar no)
//   - Reprocessar via useReprocessarRelacionamentos
// =====================================================================

import { useCallback, useMemo, useState } from "react";
import { AlertCircle, ChevronsUpDown, Layers, RefreshCcw, Workflow } from "lucide-react";
import {
  useRelacionamentosConfig,
  useRelacionamentosPanorama,
  useRelacionamentosVizinhanca,
  useReprocessarRelacionamentos,
} from "@/hooks/relacionamentos";
import { ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type {
  BackfillResultado,
  NoVisual,
  RelacionamentoTipoGrafo,
  VizinhoVisual,
} from "@/lib/api/relacionamentos-types";
import { GrafoCanvas } from "./GrafoCanvas";
import { GrafoPainelLateral } from "./GrafoPainelLateral";
import { GrafoLegenda } from "./GrafoLegenda";
import { GrafoBuscaInline } from "./GrafoBuscaInline";
import { GrafoToolbar, humanizarErroGrafo } from "./GrafoToolbar";
import { RelacionamentosArestasView } from "./RelacionamentosArestasView";

// ---------------------------------------------------------------------
// Tipos locais.
// ---------------------------------------------------------------------

interface NoSelecionado {
  tipo: NoVisual["tipo"];
  id: string;
}

/**
 * Sub-abas internas da feature "Relacionamentos > Grafo". A feature de
 * visualizacao tem duas leituras do mesmo panorama: Grafo (canvas + painel
 * lateral com vizinhos) e Arestas (tabela densa + filtros). A Toolbar
 * (Recarregar/Reprocessar) e compartilhada entre as duas.
 */
type SubabaInterna = "grafo" | "arestas";

/** Grafo default quando a config ainda nao carregou ou nao define preferencia. */
const TIPO_FALLBACK: RelacionamentoTipoGrafo = "hierarquico";
/** Limiar de clusterizacao default quando a config nao o define (F2). */
const CLUSTERING_THRESHOLD_FALLBACK = 80;
/** Profundidade maxima de expansao da vizinhanca ancorada [0..5]. */
const PROFUNDIDADE_MAX = 5;

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div
      data-loading-grafo
      className="flex flex-col items-center justify-center gap-3 py-12"
      aria-busy="true"
      aria-live="polite"
    >
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          data-loading-skeleton-row
          className="h-9 w-2/3 animate-pulse bg-surface-3"
          style={{
            // Criterio exige radius 12 explicito; usamos style inline para
            // evitar divergencia entre o design token (var(--r-md)) e o
            // valor literal exigido.
            borderRadius: "12px",
            animationDelay: `${i * 120}ms`,
          }}
        />
      ))}
      <p className="mt-2 text-[12.5px] text-muted">Carregando grafo…</p>
    </div>
  );
}

function EmptyState({ onReprocessar, isReprocessing }: {
  onReprocessar: () => void;
  isReprocessing: boolean;
}) {
  return (
    <div
      data-empty="grafo"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-surface-2/40",
        "px-6 py-12 text-center",
      )}
    >
      <Workflow className="size-8 text-muted" aria-hidden="true" />
      <p className="text-[14px] font-semibold text-fg">
        Nenhuma aresta confirmada ainda
      </p>
      <p className="max-w-md text-[12.5px] text-muted">
        O grafo aparece assim que o backfill rodar pela primeira vez ou
        quando regras humanas forem aplicadas.
      </p>
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={onReprocessar}
        disabled={isReprocessing}
        data-btn="empty-reprocessar"
      >
        <RefreshCcw aria-hidden="true" />
        <span>{isReprocessing ? "Executando…" : "Reprocessar relacionamentos"}</span>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function RelacionamentosGrafoView() {
  const { toast } = useToast();

  // Estado de selecao local (controlado pelo pai).
  const [noSelecionado, setNoSelecionado] = useState<NoSelecionado | null>(null);
  const [painelAberto, setPainelAberto] = useState(true);
  const [simular10k, setSimular10k] = useState(false);
  const [modoAgregacao, setModoAgregacao] = useState(false);
  const [reprocessStartedAt, setReprocessStartedAt] = useState<number | null>(null);
  const [ultimoResultado, setUltimoResultado] = useState<BackfillResultado | null>(null);
  /** Sub-aba interna (Grafo | Arestas). Default: Grafo. */
  const [subabaInterna, setSubabaInterna] = useState<SubabaInterna>("grafo");
  /**
   * Override manual do tipo de grafo. Enquanto null, seguimos o default da
   * config (tipo_default_panorama); ao clicar no toggle, o usuario assume o
   * controle e o override passa a valer.
   */
  const [tipoOverride, setTipoOverride] = useState<RelacionamentoTipoGrafo | null>(null);
  /**
   * Profundidade da vizinhanca ancorada. null => backend usa o default; a
   * expansao explicita (nunca automatica) incrementa este valor ate o teto.
   */
  const [profundidade, setProfundidade] = useState<number | null>(null);

  // Config singleton: defaults de tipo e limiar de clusterizacao (V2/F2).
  const config = useRelacionamentosConfig();
  const tipoDefault = config.data?.tipo_default_panorama ?? TIPO_FALLBACK;
  const tipo = tipoOverride ?? tipoDefault;
  const clusteringThreshold =
    config.data?.clustering_threshold_nos ?? CLUSTERING_THRESHOLD_FALLBACK;

  // Hooks de leitura. O panorama carrega SEMPRE um subgrafo por
  // (tipo, ancora?, profundidade) - nunca o panorama completo.
  const panorama = useRelacionamentosPanorama({
    tipo,
    no_id: noSelecionado?.id ?? null,
    profundidade,
  });
  const vizinhanca = useRelacionamentosVizinhanca(
    noSelecionado
      ? { tipo: noSelecionado.tipo, id: noSelecionado.id, profundidade: profundidade ?? undefined }
      : null,
  );

  // Hook de reprocessamento.
  const reprocessar = useReprocessarRelacionamentos();

  // -----------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------

  const handleSelectNode = useCallback((no: NoSelecionado | null) => {
    if (!no) {
      setNoSelecionado(null);
      return;
    }
    setNoSelecionado(no);
    setPainelAberto(true);
  }, []);

  const handleSelectNeighbor = useCallback((vizinho: VizinhoVisual) => {
    setNoSelecionado({ tipo: vizinho.tipo, id: vizinho.id });
  }, []);

  const handleClosePainel = useCallback(() => {
    setPainelAberto(false);
    setNoSelecionado(null);
  }, []);

  /**
   * Foco cross-subaba: vem da tabela de Arestas, volta para a sub-aba Grafo
   * com o no ja selecionado. O painel lateral abre automaticamente.
   */
  const handleFocusNoFromArestas = useCallback((no: NoSelecionado) => {
    setSubabaInterna("grafo");
    setNoSelecionado(no);
    setPainelAberto(true);
  }, []);

  const handleRefresh = useCallback(() => {
    panorama.refetch();
    vizinhanca.refetch();
  }, [panorama, vizinhanca]);

  const handleReprocessar = useCallback(async () => {
    setReprocessStartedAt(Date.now());
    try {
      const resultado = await reprocessar.mutateAsync();
      setUltimoResultado(resultado);
      toast({
        title: "Reprocessamento concluído",
        description: `arestas_criadas: ${resultado.arestas_criadas}, duracao: ${Math.round(resultado.duracao_ms / 1000)}s`,
        variant: "ok",
      });
    } catch (err) {
      toast({
        title: "Falha ao reprocessar",
        description: humanizarErroGrafo(err),
        variant: "danger",
      });
    } finally {
      setReprocessStartedAt(null);
    }
  }, [reprocessar, toast]);

  /**
   * Alterna o grafo carregado (Hierarquico <-> Semantico). Troca a fotografia
   * inteira: limpamos a profundidade expandida para nao arrastar um zoom de
   * vizinhanca de um grafo para o outro.
   */
  const handleTipoChange = useCallback((novoTipo: RelacionamentoTipoGrafo) => {
    setTipoOverride(novoTipo);
    setProfundidade(null);
    setModoAgregacao(false);
  }, []);

  /**
   * Expansao EXPLICITA da vizinhanca ancorada. Nunca automatica: so acontece
   * quando o usuario clica em "Carregar mais" no aviso de truncado, e sempre
   * com alerta de possivel queda de FPS. Incrementa a profundidade ate o teto.
   */
  const handleExpandir = useCallback(() => {
    setProfundidade((prev) => {
      const atual = prev ?? 2;
      if (atual >= PROFUNDIDADE_MAX) {
        toast({
          title: "Profundidade máxima atingida",
          description: `A vizinhança já está no limite (${PROFUNDIDADE_MAX}). Use "Agrupar por tipo" para reduzir o ruído.`,
          variant: "warn",
        });
        return prev;
      }
      const proxima = atual + 1;
      toast({
        title: "Expandindo o grafo",
        description: `Profundidade ${proxima}/${PROFUNDIDADE_MAX}. Mais nós podem reduzir o FPS da visualização 3D.`,
        variant: "warn",
      });
      return proxima;
    });
  }, [toast]);

  /** Fallback WebGL ausente: leva o usuario para a lista densa de arestas. */
  const handleAbrirListaArestas = useCallback(() => {
    setSubabaInterna("arestas");
  }, []);

  // -----------------------------------------------------------------
  // Dados derivados
  // -----------------------------------------------------------------

  const panoramaData = panorama.data;
  const nos = useMemo(() => panoramaData?.nos ?? [], [panoramaData]);
  const arestas = useMemo(() => panoramaData?.arestas ?? [], [panoramaData]);
  const truncado = panoramaData?.truncado ?? false;
  const cap = panoramaData?.cap ?? 0;
  const profundidadeAtual = profundidade ?? 2;
  const podeExpandir = profundidadeAtual < PROFUNDIDADE_MAX;

  const vizinhos: VizinhoVisual[] = useMemo(() => {
    if (!vizinhanca.data?.nos) return [];
    return vizinhanca.data.nos.filter((n) => n.profundidade > 0);
  }, [vizinhanca.data]);

  const noSelecionadoVisual: NoVisual | null = useMemo(() => {
    if (!noSelecionado) return null;
    const found = nos.find(
      (n) => n.tipo === noSelecionado.tipo && n.id === noSelecionado.id,
    );
    if (found) return found;
    // fallback: ancora devolvida pela vizinhanca
    return vizinhanca.data?.no_ancora ?? null;
  }, [nos, noSelecionado, vizinhanca.data]);

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------

  if (panorama.isLoading) {
    return (
      <div
        data-painel-grafo
        className="flex flex-col gap-3"
        aria-busy="true"
      >
        <LoadingSkeleton />
      </div>
    );
  }

  if (panorama.isError) {
    return (
      <div
        data-painel-grafo
        className="flex flex-col gap-3"
        role="alert"
      >
        <div
          data-error-grafo
          className="flex flex-col items-center gap-2 rounded-md border border-err bg-err-bg/40 p-6 text-center"
        >
          <AlertCircle className="size-6 text-err" aria-hidden="true" />
          <p className="text-[13px] font-semibold text-fg">
            Falha ao carregar o panorama
          </p>
          <p className="text-[12.5px] text-muted">
            {humanizarErroGrafo(panorama.error)}
            {panorama.error instanceof ApiError && panorama.error.code
              ? ` (codigo ${panorama.error.code})`
              : null}
          </p>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => panorama.refetch()}
            data-btn="erro-tentar-novamente"
          >
            <RefreshCcw aria-hidden="true" />
            <span>Tentar novamente</span>
          </Button>
        </div>
      </div>
    );
  }

  const isEmpty = nos.length === 0 || arestas.length === 0;

  return (
    <div
      data-painel-grafo
      className="flex h-full min-h-[520px] flex-col gap-3"
    >
      <GrafoToolbar
        isFetching={panorama.isFetching}
        isReprocessing={reprocessar.isPending}
        reprocessStartedAt={reprocessStartedAt}
        ultimoResultado={ultimoResultado}
        tipo={tipo}
        onTipoChange={handleTipoChange}
        onRefresh={handleRefresh}
        onReprocessar={handleReprocessar}
        onSimular10kChange={setSimular10k}
        simular10k={simular10k}
      />

      {/* Tabs interna: Grafo (canvas + painel lateral) | Arestas (tabela). */}
      <div
        role="tablist"
        aria-label="Sub-abas de visualizacao do grafo"
        className="flex gap-1 border-b border-border"
        data-subaba-interna-tabs
      >
        <button
          type="button"
          role="tab"
          aria-selected={subabaInterna === "grafo"}
          tabIndex={subabaInterna === "grafo" ? 0 : -1}
          onClick={() => setSubabaInterna("grafo")}
          className={cn(
            "relative inline-flex items-center gap-2 px-3 py-[10px] text-[13px] font-semibold transition-colors",
            "border-b-2 border-transparent",
            subabaInterna === "grafo"
              ? "border-[color:var(--accent)] text-accent-strong"
              : "text-muted hover:text-fg",
          )}
          data-btn="subaba-grafo"
        >
          Grafo
          {nos.length > 0 ? (
            <span
              className={cn(
                "rounded-[6px] px-1.5 py-px text-[11px] font-bold tabular-nums",
                subabaInterna === "grafo"
                  ? "bg-[color-mix(in_oklch,var(--accent)_18%,transparent)] text-accent-strong"
                  : "bg-[color-mix(in_oklch,var(--fg)_8%,transparent)] text-muted",
              )}
            >
              {nos.length}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subabaInterna === "arestas"}
          tabIndex={subabaInterna === "arestas" ? 0 : -1}
          onClick={() => setSubabaInterna("arestas")}
          className={cn(
            "relative inline-flex items-center gap-2 px-3 py-[10px] text-[13px] font-semibold transition-colors",
            "border-b-2 border-transparent",
            subabaInterna === "arestas"
              ? "border-[color:var(--accent)] text-accent-strong"
              : "text-muted hover:text-fg",
          )}
          data-btn="subaba-arestas"
        >
          Arestas
          {arestas.length > 0 ? (
            <span
              className={cn(
                "rounded-[6px] px-1.5 py-px text-[11px] font-bold tabular-nums",
                subabaInterna === "arestas"
                  ? "bg-[color-mix(in_oklch,var(--accent)_18%,transparent)] text-accent-strong"
                  : "bg-[color-mix(in_oklch,var(--fg)_8%,transparent)] text-muted",
              )}
            >
              {arestas.length}
            </span>
          ) : null}
        </button>
      </div>

      {subabaInterna === "arestas" ? (
        // Sub-aba Arestas: tabela densa com filtros. Reusa panorama.arestas
        // e panorama.nos (mesma fonte de dados do Grafo).
        <RelacionamentosArestasView
          arestas={arestas}
          nos={nos}
          onFocusNo={handleFocusNoFromArestas}
        />
      ) : isEmpty ? (
        <EmptyState
          onReprocessar={handleReprocessar}
          isReprocessing={reprocessar.isPending}
        />
      ) : (
        <div className="grid h-full min-h-[460px] grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
          {/* Canvas + overlay (busca no topo, legenda no rodape) */}
          <section
            data-grafo-stage
            className="relative overflow-hidden rounded-md border border-border bg-bg"
            style={{ minHeight: 460 }}
          >
            {/* Toolbar de busca no topo do canvas */}
            <div className="absolute left-3 top-3 right-3 z-10 flex items-start justify-between gap-2">
              <GrafoBuscaInline
                nos={nos}
                onClear={() => setNoSelecionado(null)}
              />
              {truncado ? (
                <div
                  data-truncado-aviso
                  className={cn(
                    "flex items-center gap-2 rounded-md border border-warn bg-warn-bg/40 px-2 py-1 text-[11px] font-medium text-warn",
                    "shadow-[var(--shadow-tooltip)]",
                  )}
                  role="status"
                  title={`teto de nos por grafo (${cap}) excedido; o grafo foi truncado`}
                >
                  <AlertCircle className="size-3.5" aria-hidden="true" />
                  <span>Truncado em {cap} nos</span>
                  {/* Expansao EXPLICITA (nunca automatica): carrega mais niveis
                      da vizinhanca ancorada, sempre com alerta de FPS. */}
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    onClick={handleExpandir}
                    disabled={!podeExpandir || panorama.isFetching}
                    data-btn="grafo-truncado-expandir"
                    title={
                      podeExpandir
                        ? "Carrega mais niveis da vizinhanca (pode reduzir o FPS)"
                        : `Profundidade maxima (${PROFUNDIDADE_MAX}) ja atingida`
                    }
                    className="h-6 px-2 text-[10.5px]"
                  >
                    <ChevronsUpDown aria-hidden="true" className="size-3" />
                    <span>Carregar mais</span>
                  </Button>
                  {/* Opcao de cluster/agregacao exigida quando o cap por grafo excede.
                      Agrupa nos por tipo para reduzir a complexidade visual
                      sem perder a informacao de cardinalidade. */}
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    onClick={() => setModoAgregacao((v) => !v)}
                    aria-pressed={modoAgregacao}
                    data-btn="grafo-truncado-agrupar"
                    data-btn-state={modoAgregacao ? "on" : "off"}
                    title="Agrupa os nos por tipo para reduzir o ruido visual"
                    className={cn(
                      "h-6 px-2 text-[10.5px]",
                      modoAgregacao && "border-accent bg-accent text-accent-fg",
                    )}
                  >
                    <Layers aria-hidden="true" className="size-3" />
                    <span>
                      {modoAgregacao ? "Desagrupar" : "Agrupar por tipo"}
                    </span>
                  </Button>
                </div>
              ) : null}
            </div>

            {/* Canvas */}
            <GrafoCanvas
              nos={nos}
              arestas={arestas}
              selectedNodeId={noSelecionado?.id ?? null}
              onSelectNode={handleSelectNode}
              simular10k={simular10k}
              modoAgregacao={modoAgregacao}
              clusteringThreshold={clusteringThreshold}
              onAbrirListaArestas={handleAbrirListaArestas}
            />

            {/* Legenda fixa no rodape esquerdo */}
            <div className="absolute bottom-3 left-3 z-10">
              <GrafoLegenda />
            </div>
          </section>

          {/* Painel lateral */}
          {painelAberto ? (
            <GrafoPainelLateral
              noSelecionado={noSelecionadoVisual}
              vizinhos={vizinhos}
              isLoading={vizinhanca.isLoading}
              onSelectNeighbor={handleSelectNeighbor}
              onClose={handleClosePainel}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}