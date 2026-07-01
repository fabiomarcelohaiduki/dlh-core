"use client";

// =====================================================================
// GrafoCanvas - wrapper da lib vis-network com cleanup adequado, LOD
// por zoom e foco 1-hop/2-hop.
//
// Estetica Obsidian (RNF-13): fundo escuro, edges curvas (curvedCW com
// roundness 0.08), glow amber via accent, dim elegante dos nos nao
// focados. LOD: labels somem em zoom < 0.5; labels de arestas somem em
// zoom < 0.3 para nao poluir a visao geral.
//
// Cleanup: network.destroy() no unmount evita memory leak em hot reload
// do Next e em trocas de aba dentro do workbench.
// =====================================================================

import { useEffect, useRef } from "react";
import { DataSet } from "vis-data/standalone";
import { Network, type Edge, type Node, type Options } from "vis-network/standalone";
import type { ArestaVisual, NoVisual } from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Tipos e constantes locais.
// ---------------------------------------------------------------------

export interface GrafoCanvasProps {
  nos: NoVisual[];
  arestas: ArestaVisual[];
  /** ID do no selecionado (null = sem selecao). */
  selectedNodeId: string | null;
  /** Notifica a view quando o usuario clica em um no. */
  onSelectNode: (node: { tipo: NoVisual["tipo"]; id: string } | null) => void;
  /** Quando true, gera nos/arestas sinteticos para stress-teste. */
  simular10k?: boolean;
  /**
   * Quando true (oferecido quando o panorama foi truncado por cap_panorama),
   * agrega nos por tipo em um unico no-representante com contagem, e soma
   * arestas entre tipos em uma unica aresta agregada com peso. Mantem a
   * informacao de cardinalidade sem poluir a visualizacao.
   */
  modoAgregacao?: boolean;
}

const EDGE_COLOR = "#71717a";
const EDGE_HIGHLIGHT = "#e27300";
const EDGE_DIM = "rgba(113,113,122,0.18)";
const NODE_FONT_COLOR = "#e4e4e7";
const NODE_FONT_DIM = "#71717a";

// LOD: zoom abaixo deste valor esconde labels de nos.
const ZOOM_HIDE_NODE_LABEL = 0.5;
// LOD: zoom abaixo deste valor esconde labels de arestas.
const ZOOM_HIDE_EDGE_LABEL = 0.3;

// ---------------------------------------------------------------------
// Helpers locais.
// ---------------------------------------------------------------------

/** ID estavel para vis-network (composto pelo tipo + ':' + id). */
export function nodeId(tipo: NoVisual["tipo"], id: string): string {
  return `${tipo}:${id}`;
}

/** Parser reverso do nodeId. */
function parseNodeId(visId: string): { tipo: NoVisual["tipo"]; id: string } | null {
  const idx = visId.indexOf(":");
  if (idx <= 0 || idx >= visId.length - 1) return null;
  const tipo = visId.slice(0, idx) as NoVisual["tipo"];
  const id = visId.slice(idx + 1);
  return { tipo, id };
}

/** Conjunto de ids de nos vizinhos de um no ancora (1-hop via edges). */
function computeOneHopNeighbors(visEdges: Edge[], anchorVisId: string): Set<string> {
  const neighbors = new Set<string>();
  for (const e of visEdges) {
    const from = typeof e.from === "string" ? e.from : String(e.from);
    const to = typeof e.to === "string" ? e.to : String(e.to);
    if (from === anchorVisId) neighbors.add(to);
    if (to === anchorVisId) neighbors.add(from);
  }
  return neighbors;
}

/** Resultado da agregacao por tipo (clusterizacao). */
interface AgregadoTipo {
  tipo: NoVisual["tipo"];
  quantidade: number;
  cor: string;
  icone: string;
  labelRepresentativo: string;
}

/**
 * Agrupa nos por tipo em um unico representante + contagem. Mantem a cor
 * dominante do tipo (a do primeiro no encontrado) e o label do primeiro.
 */
function aggregateByTipo(nosOriginais: NoVisual[]): NoVisual[] {
  const byTipo = new Map<NoVisual["tipo"], AgregadoTipo>();
  for (const n of nosOriginais) {
    const cur = byTipo.get(n.tipo);
    if (cur) {
      cur.quantidade += 1;
    } else {
      byTipo.set(n.tipo, {
        tipo: n.tipo,
        quantidade: 1,
        cor: n.cor,
        icone: n.icone,
        labelRepresentativo: n.label,
      });
    }
  }
  const agregados: NoVisual[] = [];
  for (const [, info] of byTipo) {
    agregados.push({
      tipo: info.tipo,
      // ID especial "__tipo__:<tipo>" para nao colidir com ids reais.
      id: `__tipo__:${info.tipo}`,
      label: `${info.tipo} (${info.quantidade})`,
      icone: info.icone,
      cor: info.cor,
    });
  }
  return agregados;
}

/**
 * Soma arestas entre pares (origem_tipo -> destino_tipo), devolvendo uma
 * aresta agregada por par com peso = quantidade de arestas originais.
 */
function aggregateEdgesByTipo(arestasOriginais: ArestaVisual[]): Edge[] {
  const counts = new Map<string, { origem: NoVisual["tipo"]; destino: NoVisual["tipo"]; quantidade: number }>();
  for (const a of arestasOriginais) {
    const key = `${a.origem_tipo}->${a.destino_tipo}`;
    const cur = counts.get(key);
    if (cur) {
      cur.quantidade += 1;
    } else {
      counts.set(key, { origem: a.origem_tipo, destino: a.destino_tipo, quantidade: 1 });
    }
  }
  const agregadas: Edge[] = [];
  let idx = 0;
  for (const [, info] of counts) {
    agregadas.push({
      id: `agg-edge-${idx++}`,
      from: nodeId(info.origem, `__tipo__:${info.origem}`),
      to: nodeId(info.destino, `__tipo__:${info.destino}`),
      label: String(info.quantidade),
      title: `${info.origem} -> ${info.destino}: ${info.quantidade} arestas`,
      width: Math.min(1 + info.quantidade * 0.05, 6),
      smooth: { enabled: true, type: "curvedCW", roundness: 0.08 },
      color: { color: EDGE_COLOR, highlight: EDGE_HIGHLIGHT, hover: EDGE_HIGHLIGHT },
    });
  }
  return agregadas;
}

/** Gera dados sinteticos para o modo "Simular 10k" (10k nos + ~30k edges). */
function generateSimulatedData(): { nodes: Node[]; edges: Edge[] } {
  const N = 10000;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const tipos: NoVisual["tipo"][] = [
    "aviso",
    "processo",
    "documento",
    "pessoa",
    "produto",
    "linha",
    "sku",
  ];
  const palette = ["#e27300", "#4ade80", "#facc15", "#60a5fa", "#a78bfa", "#f472b6", "#22d3ee"];
  for (let i = 0; i < N; i++) {
    const tipo = tipos[i % tipos.length];
    const id = `sim-${i}`;
    nodes.push({
      id: nodeId(tipo, id),
      label: `${tipo} ${i}`,
      color: {
        background: palette[i % palette.length],
        border: palette[i % palette.length],
      },
    });
  }
  // ~30k edges
  for (let i = 0; i < 30000; i++) {
    const a = Math.floor(Math.random() * N);
    const b = Math.floor(Math.random() * N);
    if (a === b) continue;
    edges.push({
      id: `sim-edge-${i}`,
      from: nodes[a].id as string,
      to: nodes[b].id as string,
      color: { color: EDGE_COLOR },
      smooth: { enabled: true, type: "curvedCW", roundness: 0.08 },
    });
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function GrafoCanvas({
  nos,
  arestas,
  selectedNodeId,
  onSelectNode,
  simular10k,
  modoAgregacao,
}: GrafoCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesRef = useRef<DataSet<Node> | null>(null);
  const edgesRef = useRef<DataSet<Edge> | null>(null);
  // Guarda o ID do zoom para reaplicar LOD.
  const lastZoomRef = useRef<number>(1);

  // ----- Montagem do network (uma vez por mount) --------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const nodesDs = new DataSet<Node>([]);
    const edgesDs = new DataSet<Edge>([]);
    nodesRef.current = nodesDs;
    edgesRef.current = edgesDs;

    const options: Options = {
      autoResize: true,
      physics: {
        enabled: true,
        solver: "forceAtlas2Based",
        stabilization: { enabled: true, iterations: 200 },
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        hoverConnectedEdges: true,
        zoomSpeed: 0.7,
      },
      nodes: {
        shape: "dot",
        size: 18,
        font: { color: NODE_FONT_COLOR, size: 12, face: "Inter, system-ui, sans-serif" },
        borderWidth: 2,
      },
      edges: {
        smooth: { enabled: true, type: "curvedCW", roundness: 0.08 },
        color: { color: EDGE_COLOR, highlight: EDGE_HIGHLIGHT, hover: EDGE_HIGHLIGHT },
        font: { color: "#a1a1aa", size: 11, strokeWidth: 0, align: "middle" },
      },
    };

    const network = new Network(container, { nodes: nodesDs, edges: edgesDs }, options);
    networkRef.current = network;

    // Desliga a fisica apos estabilizar para a UX ficar calma.
    network.once("stabilizationIterationsDone", () => {
      network.setOptions({ physics: { enabled: false } });
    });

    // Evento de selecao de no.
    network.on("selectNode", (params) => {
      const visId = (params.nodes?.[0] ?? null) as string | null;
      if (!visId) {
        onSelectNode(null);
        return;
      }
      const parsed = parseNodeId(visId);
      if (parsed) onSelectNode(parsed);
    });

    network.on("deselectNode", () => {
      onSelectNode(null);
    });

    // LOD: monitora zoom e alterna visibilidade de labels.
    network.on("zoom", (params) => {
      const z = typeof params.scale === "number" ? params.scale : 1;
      lastZoomRef.current = z;
      applyLod(nodesDs, edgesDs, z);
    });

    return () => {
      network.destroy();
      networkRef.current = null;
      nodesRef.current = null;
      edgesRef.current = null;
    };
    // onSelectNode nao entra como dep porque e setado via parent e ja e estavel
    // para este componente (callback criado com useCallback no parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Atualizacao de dados --------------------------------------
  useEffect(() => {
    const network = networkRef.current;
    const nodesDs = nodesRef.current;
    const edgesDs = edgesRef.current;
    if (!network || !nodesDs || !edgesDs) return;

    if (simular10k) {
      // Substitui os dados reais pelos sinteticos 10k para stress-teste.
      const sim = generateSimulatedData();
      nodesDs.clear();
      edgesDs.clear();
      nodesDs.add(sim.nodes);
      edgesDs.add(sim.edges);
      network.fit({ animation: { duration: 400, easingFunction: "easeInOutQuad" } });
      return;
    }

    const visNodes: Node[] = (modoAgregacao ? aggregateByTipo(nos) : nos).map((n) => ({
      id: nodeId(n.tipo, n.id),
      label: n.label,
      title: `${n.label} (${n.tipo})`,
      size: modoAgregacao ? 28 : 18,
      color: {
        background: n.cor,
        border: n.cor,
        highlight: { background: n.cor, border: EDGE_HIGHLIGHT },
      },
    }));

    const visEdges: Edge[] = (modoAgregacao
      ? aggregateEdgesByTipo(arestas)
      : arestas.map((a, idx) => ({
          id: `e-${idx}`,
          from: nodeId(a.origem_tipo, a.origem_id),
          to: nodeId(a.destino_tipo, a.destino_id),
          label: a.metodo,
          title: `${a.relacao} · confianca ${(a.confianca * 100).toFixed(0)}%`,
          smooth: { enabled: true, type: "curvedCW", roundness: 0.08 },
          color: { color: EDGE_COLOR, highlight: EDGE_HIGHLIGHT, hover: EDGE_HIGHLIGHT },
        }))
    );

    nodesDs.clear();
    edgesDs.clear();
    nodesDs.add(visNodes);
    edgesDs.add(visEdges);
    network.fit({ animation: { duration: 400, easingFunction: "easeInOutQuad" } });
    applyLod(nodesDs, edgesDs, lastZoomRef.current);
  }, [nos, arestas, simular10k, modoAgregacao]);

  // ----- Aplicacao de foco 1-hop/2-hop quando selectedNodeId muda --
  useEffect(() => {
    const network = networkRef.current;
    const nodesDs = nodesRef.current;
    const edgesDs = edgesRef.current;
    if (!network || !nodesDs || !edgesDs) return;

    const allNodes = nodesDs.get();
    const allEdges = edgesDs.get();

    // Limpa overrides previos.
    nodesDs.update(
      allNodes.map((n) => ({
        id: n.id as string,
        opacity: 1,
        font: { color: NODE_FONT_COLOR, size: 12 },
      })),
    );
    edgesDs.update(
      allEdges.map((e) => ({
        id: e.id as string,
        color: { color: EDGE_COLOR, highlight: EDGE_HIGHLIGHT, hover: EDGE_HIGHLIGHT },
      })),
    );

    if (!selectedNodeId) return;

    // Encontra o ancora (pode ser um tipo especifico; varrendo todos).
    const anchorCandidates = allNodes.filter((n) =>
      String(n.id).endsWith(`:${selectedNodeId}`),
    );
    if (anchorCandidates.length === 0) return;
    const anchorVisId = String(anchorCandidates[0].id);

    const oneHop = computeOneHopNeighbors(allEdges, anchorVisId);

    // Aplica dim nos nos fora do conjunto foco (ancora + 1-hop).
    nodesDs.update(
      allNodes
        .filter((n) => {
          const visId = String(n.id);
          return visId !== anchorVisId && !oneHop.has(visId);
        })
        .map((n) => ({
          id: n.id as string,
          opacity: 0.18,
          font: { color: NODE_FONT_DIM, size: 12 },
        })),
    );

    // Aplica dim nas arestas que NAO tocam o ancora.
    edgesDs.update(
      allEdges
        .filter((e) => {
          const from = typeof e.from === "string" ? e.from : String(e.from);
          const to = typeof e.to === "string" ? e.to : String(e.to);
          return from !== anchorVisId && to !== anchorVisId;
        })
        .map((e) => ({
          id: e.id as string,
          color: { color: EDGE_DIM, highlight: EDGE_HIGHLIGHT, hover: EDGE_HIGHLIGHT },
        })),
    );

    // Centraliza o ancora na viewport.
    try {
      network.focus(anchorVisId, {
        scale: 1,
        animation: { duration: 400, easingFunction: "easeInOutQuad" },
      });
    } catch {
      // Ignora se vis-network nao conseguir focar (no removido).
    }
  }, [selectedNodeId]);

  // ----- API imperativa para o pai (busca/foco por id) --------------
  useEffect(() => {
    // Expõe o foco via custom event (o pai dispara window.dispatchEvent).
    function handleFocusEvent(event: Event) {
      const network = networkRef.current;
      if (!network) return;
      const detail = (event as CustomEvent<{ visId: string }>).detail;
      if (!detail?.visId) return;
      try {
        network.focus(detail.visId, {
          scale: 1.1,
          animation: { duration: 400, easingFunction: "easeInOutQuad" },
        });
        network.selectNodes([detail.visId]);
      } catch {
        // ignora
      }
    }
    window.addEventListener("dlh-grafo-focus", handleFocusEvent);
    return () => window.removeEventListener("dlh-grafo-focus", handleFocusEvent);
  }, []);

  return (
    <div
      ref={containerRef}
      data-grafo-canvas
      data-testid="grafo-canvas"
      className="h-full w-full"
      style={{ minHeight: 420, background: "var(--bg)" }}
    />
  );
}

// ---------------------------------------------------------------------
// LOD: aplica regras de visibilidade de labels por zoom.
// ---------------------------------------------------------------------

function applyLod(nodesDs: DataSet<Node>, edgesDs: DataSet<Edge>, zoom: number) {
  // Restaura labels de nos com tamanho 12 (default visivel).
  const allNodes = nodesDs.get();
  nodesDs.update(
    allNodes.map((n) => ({
      id: n.id as string,
      font: { color: NODE_FONT_COLOR, size: 12 },
    })),
  );

  // Restaura labels de arestas.
  const allEdges = edgesDs.get();
  edgesDs.update(
    allEdges.map((e) => ({
      id: e.id as string,
      font: { color: "#a1a1aa", size: 11 },
    })),
  );

  if (zoom < ZOOM_HIDE_NODE_LABEL) {
    // Esconde labels de nos.
    nodesDs.update(
      allNodes.map((n) => ({
        id: n.id as string,
        font: { color: NODE_FONT_COLOR, size: 0 },
      })),
    );
  } else if (zoom < ZOOM_HIDE_EDGE_LABEL) {
    // Esconde labels de arestas (mas mantem nos visiveis).
    edgesDs.update(
      allEdges.map((e) => ({
        id: e.id as string,
        font: { color: "#a1a1aa", size: 0 },
      })),
    );
  }
}