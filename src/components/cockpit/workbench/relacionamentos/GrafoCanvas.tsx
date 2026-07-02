"use client";

// =====================================================================
// GrafoCanvas - motor 3D REAL da teia de relacionamentos (F2 / D2).
//
// Troca o antigo render 2D (vis-network) pelo wrapper
// `react-force-graph-3d` (peers `three` + `@types/three`). A estetica
// Obsidian e construida SOBRE as APIs do wrapper (sem reimplementar o
// layout force-directed):
//   - fundo Obsidian (#0B0F14) via backgroundColor
//   - glow ambar por no via nodeThreeObject (sprite de halo aditivo)
//   - arestas curvas via linkCurvature; cor/realce via linkColor
//   - dim elegante dos nos/arestas fora do foco (ancora + 1-hop)
//   - LOD por densidade: labels e halos somem quando ha muitos nos
//   - onEngineTick marca quando as coordenadas estao prontas para o
//     enquadramento e o foco de camera na selecao
//
// SSR do Next: `react-force-graph-3d` acessa window/document no import,
// entao a lib e carregada client-side (import dinamico dentro de effect,
// preservando o ref-como-prop nativo do wrapper em React 19).
//
// WebGL ausente: renderiza um Card "Visualizacao 3D indisponivel" com
// botao "Abrir lista de arestas" (fallback para a sub-aba Arestas).
//
// Clusterizacao por densidade: acima de `clusteringThreshold` (default
// 80) os nos sao agregados por tipo em nos-cluster clicaveis que
// expandem o grupo sob demanda. Respeita o cap ja aplicado pelo backend
// (sempre subgrafo por ancora + profundidade + tipo).
//
// O contrato de props e preservado (nos/arestas/selectedNodeId/
// onSelectNode/simular10k/modoAgregacao); novos campos sao opcionais.
// =====================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type {
  ForceGraphMethods,
  GraphData,
  LinkObject,
  NodeObject,
} from "react-force-graph-3d";
import { MonitorX } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ArestaVisual, NoVisual } from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Tipos e constantes locais.
// ---------------------------------------------------------------------

export interface GrafoCanvasProps {
  nos: NoVisual[];
  arestas: ArestaVisual[];
  /** ID (realId) do no selecionado (null = sem selecao). */
  selectedNodeId: string | null;
  /** Notifica a view quando o usuario clica em um no real. */
  onSelectNode: (node: { tipo: NoVisual["tipo"]; id: string } | null) => void;
  /** Quando true, gera nos/arestas sinteticos para stress-teste. */
  simular10k?: boolean;
  /**
   * Quando true, forca a clusterizacao por tipo independentemente do
   * limiar de densidade (usado pela acao "Agrupar por tipo" no truncado).
   */
  modoAgregacao?: boolean;
  /** Limiar de nos acima do qual a UI clusteriza por densidade (default 80). */
  clusteringThreshold?: number;
  /** Fallback do WebGL ausente: abre a sub-aba de Arestas (lista densa). */
  onAbrirListaArestas?: () => void;
}

/** Estetica Obsidian (DLH4). */
const OBSIDIAN_BG = "#0B0F14";
const ACCENT = "#A78BFA"; // roxo Obsidian (nos-cluster)
const AMBER = "#FBBF24"; // ambar de realce/glow
const EDGE_BASE = "rgba(148,163,184,0.32)";
const EDGE_INTERNAL = "rgba(148,163,184,0.22)";
const EDGE_DIM = "rgba(148,163,184,0.06)";
const NODE_DIM = "#2A2F37";
const LABEL_COLOR = "#E5E7EB";

/** LOD: acima deste numero de nos escondemos labels (evita poluicao). */
const LABEL_DENSITY_LIMIT = 60;
/** LOD: acima deste numero de nos escondemos os halos de glow. */
const GLOW_DENSITY_LIMIT = 300;
/** Default do limiar de clusterizacao por densidade. */
const DEFAULT_CLUSTERING_THRESHOLD = 80;

// Campos que anexamos a cada no/aresta do force-graph.
interface NodeExtra {
  tipo: string;
  realId: string;
  label: string;
  cor: string;
  icone: string;
  isCluster?: boolean;
  clusterTipo?: string;
  count?: number;
}
type FgNode = NodeObject & NodeExtra;

interface LinkExtra {
  relacao?: string;
  metodo?: string;
  confianca?: number;
  weight?: number;
}
type FgLink = LinkObject & LinkExtra;

/** Ref imperativo do wrapper (default generics batem com o ref-prop). */
type GraphInstance = ForceGraphMethods<NodeObject, LinkObject>;
/** Tipo do componente default carregado dinamicamente. */
type ForceGraphComponent = (typeof import("react-force-graph-3d"))["default"];

// ---------------------------------------------------------------------
// Helpers de identidade.
// ---------------------------------------------------------------------

/** ID estavel de um no real. */
export function nodeId(tipo: string, id: string): string {
  return `${tipo}:${id}`;
}

/** ID de um no-cluster (nao colide com ids reais). */
function clusterId(tipo: string): string {
  return `cluster:${tipo}`;
}

/** Resolve o id de uma extremidade de aresta (string ou node ja resolvido). */
function endpointId(ref: string | number | NodeObject | undefined): string {
  if (ref == null) return "";
  if (typeof ref === "object") return String((ref as NodeObject).id ?? "");
  return String(ref);
}

// ---------------------------------------------------------------------
// Recursos three compartilhados (glow) e sprites de label.
// ---------------------------------------------------------------------

let glowTexture: THREE.Texture | null = null;

/** Textura de halo radial branca (reutilizada; tingida por material). */
function getGlowTexture(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.35, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

/** Sprite de glow aditivo (estetica Obsidian). */
function makeGlowSprite(colorHex: string, scale: number): THREE.Sprite {
  const material = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: new THREE.Color(colorHex),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(scale, scale, 1);
  return sprite;
}

/** Sprite de texto (label do no) desenhado num canvas. */
function makeLabelSprite(text: string): THREE.Sprite | null {
  const fontSize = 40;
  const padX = 14;
  const padY = 10;
  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d");
  if (!mctx) return null;
  const font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
  mctx.font = font;
  const textWidth = Math.min(mctx.measureText(text).width, 520);
  const width = Math.ceil(textWidth + padX * 2);
  const height = Math.ceil(fontSize + padY * 2);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  // pilula translucida para legibilidade sobre o fundo escuro
  ctx.fillStyle = "rgba(11,15,20,0.62)";
  const r = 8;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(width, 0, width, height, r);
  ctx.arcTo(width, height, 0, height, r);
  ctx.arcTo(0, height, 0, 0, r);
  ctx.arcTo(0, 0, width, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = LABEL_COLOR;
  ctx.fillText(text, padX, height / 2, textWidth);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  const unitsPerPx = 0.16;
  sprite.scale.set(width * unitsPerPx, height * unitsPerPx, 1);
  sprite.position.set(0, 9, 0); // acima do no
  return sprite;
}

// ---------------------------------------------------------------------
// Deteccao de WebGL.
// ---------------------------------------------------------------------

function detectWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");
    return Boolean(window.WebGLRenderingContext && gl);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Construcao dos dados do grafo (real, clusterizado ou sintetico).
// ---------------------------------------------------------------------

/** Label reduzido garantindo identificador concreto (nunca "Item N"). */
function labelConcreto(n: NoVisual): string {
  const base = (n.label ?? "").trim();
  if (base) return base.length > 42 ? `${base.slice(0, 41)}…` : base;
  // fallback: tipo + fragmento do id real (jamais um rotulo generico).
  const frag = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
  return `${n.tipo} · ${frag}`;
}

function toRealNode(n: NoVisual): FgNode {
  return {
    id: nodeId(n.tipo, n.id),
    tipo: n.tipo,
    realId: n.id,
    label: labelConcreto(n),
    cor: n.cor,
    icone: n.icone,
  };
}

function toRealLink(a: ArestaVisual): FgLink {
  return {
    source: nodeId(a.origem_tipo, a.origem_id),
    target: nodeId(a.destino_tipo, a.destino_id),
    relacao: a.relacao,
    metodo: a.metodo,
    confianca: a.confianca,
  };
}

/** Dados sinteticos para o modo "Simular 10k" (stress-teste dev). */
function buildSimulatedData(): GraphData<NodeObject, LinkObject> {
  const N = 10000;
  const tipos = ["aviso", "processo", "documento", "pessoa", "produto", "linha", "sku"];
  const palette = ["#e27300", "#4ade80", "#facc15", "#60a5fa", ACCENT, "#f472b6", "#22d3ee"];
  const nodes: FgNode[] = [];
  for (let i = 0; i < N; i++) {
    const tipo = tipos[i % tipos.length];
    nodes.push({
      id: nodeId(tipo, `sim-${i}`),
      tipo,
      realId: `sim-${i}`,
      label: `${tipo} ${i}`,
      cor: palette[i % palette.length],
      icone: "circle",
    });
  }
  const links: FgLink[] = [];
  for (let i = 0; i < 22000; i++) {
    const a = Math.floor(Math.random() * N);
    const b = Math.floor(Math.random() * N);
    if (a === b) continue;
    links.push({ source: nodes[a].id as string, target: nodes[b].id as string });
  }
  return { nodes, links };
}

/**
 * Constroi os dados do grafo aplicando clusterizacao por tipo quando ativa.
 * Tipos NAO expandidos colapsam em um unico no-cluster com contagem; os
 * expandidos exibem seus nos reais. Arestas sao remapeadas para as
 * extremidades visiveis e agregadas por par (peso), sem self-loops de cluster.
 */
function buildClusteredData(
  nos: NoVisual[],
  arestas: ArestaVisual[],
  expanded: Set<string>,
): GraphData<NodeObject, LinkObject> {
  const tiposPresentes = new Set(nos.map((n) => n.tipo));
  const collapsed = new Set<string>();
  for (const t of tiposPresentes) if (!expanded.has(t)) collapsed.add(t);

  // Contagem por tipo (para o rotulo do cluster).
  const countByTipo = new Map<string, number>();
  for (const n of nos) countByTipo.set(n.tipo, (countByTipo.get(n.tipo) ?? 0) + 1);
  const corByTipo = new Map<string, string>();
  for (const n of nos) if (!corByTipo.has(n.tipo)) corByTipo.set(n.tipo, n.cor);

  const nodes: FgNode[] = [];
  // Clusters para tipos colapsados.
  for (const tipo of collapsed) {
    const count = countByTipo.get(tipo) ?? 0;
    nodes.push({
      id: clusterId(tipo),
      tipo,
      realId: tipo,
      label: `${tipo} (${count})`,
      cor: corByTipo.get(tipo) ?? ACCENT,
      icone: "layers",
      isCluster: true,
      clusterTipo: tipo,
      count,
    });
  }
  // Nos reais para tipos expandidos.
  for (const n of nos) {
    if (collapsed.has(n.tipo)) continue;
    nodes.push(toRealNode(n));
  }

  // Remapeia extremidades: tipos colapsados -> cluster.
  const mapEndpoint = (tipo: string, id: string): string =>
    collapsed.has(tipo) ? clusterId(tipo) : nodeId(tipo, id);

  const aggregated = new Map<string, FgLink>();
  for (const a of arestas) {
    const s = mapEndpoint(a.origem_tipo, a.origem_id);
    const t = mapEndpoint(a.destino_tipo, a.destino_id);
    if (s === t) continue; // descarta self-loop de cluster
    const key = `${s}->${t}`;
    const cur = aggregated.get(key);
    if (cur) {
      cur.weight = (cur.weight ?? 1) + 1;
    } else {
      aggregated.set(key, {
        source: s,
        target: t,
        relacao: a.relacao,
        metodo: a.metodo,
        confianca: a.confianca,
        weight: 1,
      });
    }
  }
  return { nodes, links: Array.from(aggregated.values()) };
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
  clusteringThreshold = DEFAULT_CLUSTERING_THRESHOLD,
  onAbrirListaArestas,
}: GrafoCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<GraphInstance | undefined>(undefined);
  const engineTickedRef = useRef(false);

  // Componente carregado client-side (evita crash de SSR).
  const [ForceGraph3D, setForceGraph3D] = useState<ForceGraphComponent | null>(null);
  const [webglOk, setWebglOk] = useState<boolean | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // Clusters expandidos sob demanda (tipo -> visivel expandido).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // ----- Carregamento client-side + deteccao de WebGL ----------------
  useEffect(() => {
    const ok = detectWebGL();
    setWebglOk(ok);
    if (!ok) return;
    let mounted = true;
    void import("react-force-graph-3d").then((mod) => {
      if (mounted) setForceGraph3D(() => mod.default);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // ----- Medicao do container (ForceGraph precisa de w/h explicitos) -
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ForceGraph3D]);

  // ----- Reset de clusters expandidos quando o subgrafo troca --------
  useEffect(() => {
    setExpanded(new Set());
  }, [nos, arestas]);

  // ----- Clusterizacao por densidade / agregacao forcada -------------
  const clusteringActive = useMemo(() => {
    if (simular10k) return false;
    if (modoAgregacao) return true;
    return nos.length > clusteringThreshold;
  }, [simular10k, modoAgregacao, nos.length, clusteringThreshold]);

  // ----- Dados do grafo (memoizados: recriar reinicia a simulacao) ---
  const graphData = useMemo<GraphData<NodeObject, LinkObject>>(() => {
    if (simular10k) return buildSimulatedData();
    if (clusteringActive) return buildClusteredData(nos, arestas, expanded);
    return { nodes: nos.map(toRealNode), links: arestas.map(toRealLink) };
  }, [nos, arestas, simular10k, clusteringActive, expanded]);

  const nodeCount = graphData.nodes.length;
  const showLabels = nodeCount <= LABEL_DENSITY_LIMIT;
  const showGlow = nodeCount <= GLOW_DENSITY_LIMIT;

  // ----- Conjunto de foco (ancora + 1-hop) ---------------------------
  const focusRef = useRef<{ anchor: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!selectedNodeId) {
      focusRef.current = null;
    } else {
      const anchor = graphData.nodes.find(
        (n) => (n as FgNode).realId === selectedNodeId,
      );
      if (!anchor) {
        focusRef.current = null;
      } else {
        const anchorKey = String(anchor.id);
        const ids = new Set<string>([anchorKey]);
        for (const l of graphData.links) {
          const s = endpointId(l.source);
          const t = endpointId(l.target);
          if (s === anchorKey) ids.add(t);
          if (t === anchorKey) ids.add(s);
        }
        focusRef.current = { anchor: anchorKey, ids };
      }
    }
    // Re-avalia os acessores de cor apos a mudanca de foco.
    fgRef.current?.refresh();

    // Foco de camera quando as coordenadas ja estao prontas.
    if (selectedNodeId && engineTickedRef.current) {
      const target = graphData.nodes.find(
        (n) => (n as FgNode).realId === selectedNodeId,
      );
      if (target && typeof target.x === "number") {
        const x = target.x;
        const y = typeof target.y === "number" ? target.y : 0;
        const z = typeof target.z === "number" ? target.z : 0;
        const dist = 160;
        const ratio = 1 + dist / Math.max(1, Math.hypot(x, y, z));
        fgRef.current?.cameraPosition(
          { x: x * ratio, y: y * ratio, z: z * ratio },
          { x, y, z },
          700,
        );
      }
    }
  }, [selectedNodeId, graphData]);

  // ----- Busca inline: foca o no via CustomEvent ---------------------
  useEffect(() => {
    function handleFocusEvent(event: Event) {
      const detail = (event as CustomEvent<{ visId: string }>).detail;
      const visId = detail?.visId;
      if (!visId) return;
      const target = graphData.nodes.find((n) => String(n.id) === visId);
      const extra = target as FgNode | undefined;
      if (extra && !extra.isCluster) {
        onSelectNode({ tipo: extra.tipo as NoVisual["tipo"], id: extra.realId });
      }
    }
    window.addEventListener("dlh-grafo-focus", handleFocusEvent);
    return () => window.removeEventListener("dlh-grafo-focus", handleFocusEvent);
  }, [graphData, onSelectNode]);

  // ----- Acessores da estetica Obsidian ------------------------------
  const nodeColor = useCallback((node: NodeObject): string => {
    const n = node as FgNode;
    const focus = focusRef.current;
    if (focus && !focus.ids.has(String(n.id))) return NODE_DIM;
    if (n.isCluster) return ACCENT;
    return n.cor;
  }, []);

  const nodeVal = useCallback((node: NodeObject): number => {
    const n = node as FgNode;
    if (n.isCluster) return Math.min(20, 4 + (n.count ?? 0) * 0.15);
    return 3;
  }, []);

  const nodeLabelAccessor = useCallback((node: NodeObject): string => {
    const n = node as FgNode;
    if (n.isCluster) return `${n.tipo}: ${n.count} nos (clique para expandir)`;
    return `${n.label} · ${n.tipo}`;
  }, []);

  const nodeThreeObject = useCallback(
    (node: NodeObject): THREE.Object3D => {
      const n = node as FgNode;
      const group = new THREE.Group();
      if (showGlow || n.isCluster) {
        const glowScale = n.isCluster ? 34 : 15;
        group.add(makeGlowSprite(n.isCluster ? ACCENT : AMBER, glowScale));
      }
      if (showLabels || n.isCluster) {
        const label = makeLabelSprite(n.label);
        if (label) group.add(label);
      }
      return group;
    },
    [showGlow, showLabels],
  );

  const linkColor = useCallback((link: LinkObject): string => {
    const focus = focusRef.current;
    const s = endpointId(link.source);
    const t = endpointId(link.target);
    if (focus) {
      if (s === focus.anchor || t === focus.anchor) return AMBER;
      if (focus.ids.has(s) && focus.ids.has(t)) return EDGE_INTERNAL;
      return EDGE_DIM;
    }
    return EDGE_BASE;
  }, []);

  const linkWidth = useCallback((link: LinkObject): number => {
    const l = link as FgLink;
    const focus = focusRef.current;
    const touchesAnchor =
      focus &&
      (endpointId(link.source) === focus.anchor ||
        endpointId(link.target) === focus.anchor);
    const base = l.weight && l.weight > 1 ? Math.min(4, 0.6 + l.weight * 0.08) : 0.6;
    return touchesAnchor ? Math.max(base, 1.6) : base;
  }, []);

  // ----- Interacao ---------------------------------------------------
  const handleNodeClick = useCallback(
    (node: NodeObject): void => {
      const n = node as FgNode;
      if (n.isCluster && n.clusterTipo) {
        // Expande o cluster sob demanda (E4).
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(n.clusterTipo as string);
          return next;
        });
        return;
      }
      onSelectNode({ tipo: n.tipo as NoVisual["tipo"], id: n.realId });
    },
    [onSelectNode],
  );

  const handleBackgroundClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  const handleEngineTick = useCallback(() => {
    engineTickedRef.current = true;
  }, []);

  const handleEngineStop = useCallback(() => {
    // Enquadra o subgrafo quando a simulacao estabiliza.
    try {
      fgRef.current?.zoomToFit(600, 60);
    } catch {
      // ignore: instancia pode ter sido desmontada
    }
  }, []);

  // ----- Render ------------------------------------------------------

  // WebGL indisponivel: fallback honesto.
  if (webglOk === false) {
    return (
      <div
        data-grafo-canvas
        data-grafo-webgl="off"
        className="flex h-full w-full items-center justify-center p-6"
        style={{ minHeight: 420, background: OBSIDIAN_BG }}
      >
        <Card className="flex max-w-sm flex-col items-center gap-3 text-center">
          <MonitorX className="size-8 text-muted" aria-hidden="true" />
          <p className="text-[14px] font-semibold text-fg">
            Visualizacao 3D indisponivel
          </p>
          <p className="text-[12.5px] text-muted">
            Seu navegador ou dispositivo nao expoe WebGL, necessario para o
            motor 3D. Use a lista de arestas para inspecionar os vinculos.
          </p>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => onAbrirListaArestas?.()}
            data-btn="webgl-abrir-arestas"
          >
            Abrir lista de arestas
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-grafo-canvas
      data-testid="grafo-canvas"
      className={cn("h-full w-full")}
      style={{ minHeight: 420, background: OBSIDIAN_BG }}
    >
      {ForceGraph3D && size.w > 0 && size.h > 0 ? (
        <ForceGraph3D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={graphData}
          backgroundColor={OBSIDIAN_BG}
          showNavInfo={false}
          nodeRelSize={4}
          nodeVal={nodeVal}
          nodeColor={nodeColor}
          nodeLabel={nodeLabelAccessor}
          nodeOpacity={0.92}
          nodeThreeObject={nodeThreeObject}
          nodeThreeObjectExtend
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkCurvature={0.12}
          linkOpacity={0.55}
          warmupTicks={20}
          cooldownTicks={120}
          onEngineTick={handleEngineTick}
          onEngineStop={handleEngineStop}
          onNodeClick={handleNodeClick}
          onBackgroundClick={handleBackgroundClick}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center"
          style={{ minHeight: 420 }}
          aria-busy="true"
        >
          <span className="text-[12.5px] text-muted">Preparando motor 3D…</span>
        </div>
      )}
    </div>
  );
}
