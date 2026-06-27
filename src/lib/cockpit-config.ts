// =====================================================================
// cockpit-config.ts — catalogo declarativo de escopos configuraveis.
//
// Fonte unica dos escopos que alimentam os engines de visibilidade/ordem/banda
// (ver lib/engines). Tres familias:
//   - COCKPIT_CARDS   (tipo `card`)   -> cards de modulo no cockpit
//   - COCKPIT_WIDGETS (tipo `widget`) -> paineis fixos do cockpit
//   - MODULE_CONFIGS  (tipo `bloco`)  -> blocos de layout por tela de cada modulo
//
// Na Fase 0 as telas de negocio ainda nao expoem blocos reais; este catalogo e
// a descricao canonica usada pela view "Configuracoes do modulo" (block-matrix)
// e pelo "Estado do modulo" (read-only). Renomear um rotulo aqui propaga para a
// UI sem tocar em mais nada. As CHAVES (escopo/id) sao o codigo interno e nao
// devem mudar — so o texto.
// =====================================================================

import type { BlocoBanda } from "@/types/database";

/** Os 3 modulos canonicos (espelham NAV_MODULES). */
export type ModuloId = "ingestao" | "cadastros" | "automacoes";

// ---------------------------------------------------------------------
// Cards de modulo (tipo `card`)
// ---------------------------------------------------------------------

export interface CardCatalogItem {
  /** escopo = id do modulo (1 card por modulo). */
  escopo: ModuloId;
  title: string;
  description: string;
  href: string;
  iconKey: ModuloId;
}

export const COCKPIT_CARDS: readonly CardCatalogItem[] = [
  {
    escopo: "ingestao",
    title: "Ingestão",
    description: "Coleta, extração e indexação de documentos.",
    href: "/ingestao/coleta",
    iconKey: "ingestao",
  },
  {
    escopo: "cadastros",
    title: "Cadastros",
    description: "Linhas, produtos, lista de materiais e revenda.",
    href: "/produtos",
    iconKey: "cadastros",
  },
  {
    escopo: "automacoes",
    title: "Automações",
    description: "Triagem assistida e regras operacionais.",
    href: "/automacao/avisos",
    iconKey: "automacoes",
  },
];

// ---------------------------------------------------------------------
// Paineis fixos (tipo `widget`)
// ---------------------------------------------------------------------

export interface WidgetCatalogItem {
  escopo: string;
  label: string;
  desc: string;
}

export const COCKPIT_WIDGETS: readonly WidgetCatalogItem[] = [
  {
    escopo: "mapa-sinais",
    label: "Mapa de sinais",
    desc: "Linha do tempo das automações monitoradas.",
  },
  {
    escopo: "saude-cockpit",
    label: "Saúde do cockpit",
    desc: "Indicador agregado da saúde operacional.",
  },
  {
    escopo: "atalhos-operacionais",
    label: "Atalhos operacionais",
    desc: "Acessos rápidos às ações do dia a dia.",
  },
];

/** Opção de dado selecionável de um painel fixo (delta-17/29). */
export interface WidgetDataOption {
  id: string;
  label: string;
}

/**
 * Catálogo de dados por painel fixo. A escolha mora em `bloco_config.valor`
 * (tipo widget) e é aplicada ao vivo pelo painel. Apenas o Mapa de sinais tem
 * dado configurável (filtro da linha do tempo) — Saúde e Atalhos leem dado real
 * agregado e caem no fallback honesto "Sem dado configurado" na configuração.
 */
export const WIDGET_DATA: Readonly<Record<string, readonly WidgetDataOption[]>> = {
  "mapa-sinais": [
    { id: "todos", label: "Todos os sinais" },
    { id: "pendencias", label: "Apenas pendências" },
    { id: "erros", label: "Apenas erros" },
  ],
};

/** Opções de dado disponíveis para um painel (vazio = sem dado configurável). */
export function widgetDataFor(escopo: string): readonly WidgetDataOption[] {
  return WIDGET_DATA[escopo] ?? [];
}

// ---------------------------------------------------------------------
// Blocos de layout por tela (tipo `bloco`)
// ---------------------------------------------------------------------

/** Definicao de um bloco de layout reutilizavel. */
export interface BlockDef {
  id: string;
  label: string;
  desc: string;
  /** Banda (regiao da tela) onde o bloco nasce por padrao. */
  banda: BlocoBanda;
}

/** Biblioteca canonica de blocos (delta-08/10..15). */
export const BLOCK_LIBRARY: readonly BlockDef[] = [
  { id: "fontes", label: "Guias do topo", desc: "Abas de fonte ou categoria no topo.", banda: "topo" },
  { id: "recurso", label: "Filtro de recurso", desc: "Sub-filtro de recursos da fonte.", banda: "topo" },
  { id: "tempo-real", label: "Tempo real", desc: "Indicador de execução ao vivo.", banda: "status" },
  { id: "busca", label: "Busca", desc: "Campo de pesquisa da lista.", banda: "ferramentas" },
  { id: "filtros", label: "Filtros", desc: "Seletores de status, tipo e período.", banda: "ferramentas" },
  { id: "acao-principal", label: "Ação principal", desc: "Botão de ação principal da tela.", banda: "acao" },
  { id: "lote", label: "Seleção em lote", desc: "Marcar itens e agir em vários.", banda: "tabela" },
  { id: "acoes-linha", label: "Ações por linha", desc: "Ícones e menu por item.", banda: "tabela" },
];

/** Indice id -> BlockDef para resolucao rapida. */
export const BLOCK_DEF: Readonly<Record<string, BlockDef>> = Object.fromEntries(
  BLOCK_LIBRARY.map((b) => [b.id, b]),
);

/** Tela de um modulo com sua lista de blocos aplicaveis (por id). */
export interface ScreenDef {
  id: string;
  label: string;
  blocks: readonly string[];
}

/** Tom da pill do "Estado do modulo" (read-only). */
export type EstadoTom = "neutral" | "ok" | "warn";

/** Item read-only do painel "Estado do modulo". */
export interface EstadoItem {
  label: string;
  desc: string;
  valor: string;
  tom: EstadoTom;
}

/** Configuracao completa de um modulo (telas + estado read-only). */
export interface ModuleConfig {
  id: ModuloId;
  label: string;
  screens: readonly ScreenDef[];
  estado: readonly EstadoItem[];
}

export const MODULE_CONFIGS: Readonly<Record<ModuloId, ModuleConfig>> = {
  ingestao: {
    id: "ingestao",
    label: "Ingestão",
    screens: [
      {
        id: "coleta",
        label: "Coleta",
        blocks: ["fontes", "recurso", "tempo-real", "busca", "filtros", "acao-principal", "lote", "acoes-linha"],
      },
      { id: "extracao", label: "Extração", blocks: ["busca", "filtros", "acao-principal", "lote", "acoes-linha"] },
      { id: "indexacao", label: "Indexação", blocks: ["busca", "filtros", "acao-principal", "acoes-linha"] },
      { id: "fontes", label: "Fontes e credenciais", blocks: ["acao-principal"] },
    ],
    estado: [
      { label: "Origem dos dados", desc: "Como o módulo recebe documentos para ingestão.", valor: "Automática", tom: "neutral" },
      { label: "Frequência de leitura", desc: "Intervalo de varredura das fontes monitoradas.", valor: "A cada 15 min", tom: "neutral" },
      { label: "Classificação automática", desc: "Pré-categoriza documentos antes da fila.", valor: "Ativa", tom: "ok" },
      { label: "Uso nas automações", desc: "Dados ingeridos ficam disponíveis para os gatilhos.", valor: "Habilitado", tom: "ok" },
    ],
  },
  cadastros: {
    id: "cadastros",
    label: "Cadastros",
    screens: [
      { id: "produtos", label: "Produtos", blocks: ["fontes", "busca", "filtros", "acao-principal", "lote", "acoes-linha"] },
      { id: "linhas-produtos", label: "Linhas de produtos", blocks: ["fontes", "busca", "filtros", "acao-principal", "lote", "acoes-linha"] },
      { id: "insumos", label: "Lista de Materiais", blocks: ["busca", "filtros", "acao-principal", "lote", "acoes-linha"] },
      { id: "revenda", label: "Revenda", blocks: ["busca", "acao-principal", "acoes-linha"] },
    ],
    estado: [
      { label: "Campos obrigatórios", desc: "Define quais campos travam o salvamento do registro.", valor: "Definidos", tom: "neutral" },
      { label: "Validação de duplicidade", desc: "Bloqueia registros repetidos por chave única.", valor: "Ativa", tom: "ok" },
      { label: "Revisão antes de publicar", desc: "Exige conferência antes do dado virar oficial.", valor: "Opcional", tom: "warn" },
      { label: "Uso nas automações", desc: "Dados cadastrados ficam disponíveis para os gatilhos.", valor: "Habilitado", tom: "ok" },
    ],
  },
  automacoes: {
    id: "automacoes",
    label: "Automações",
    // Automações expõe apenas o submódulo "Configurações do módulo" na lateral
    // (SPEC §sidebar): não há telas funcionais com blocos de layout. Por isso a
    // matriz de blocos renderiza estado vazio honesto para este módulo.
    screens: [],
    estado: [
      { label: "Fontes de dados", desc: "Combina dados de Ingestão e de Cadastros nos gatilhos.", valor: "Ingestão + Cadastros", tom: "neutral" },
      { label: "Janela de execução", desc: "Período em que as automações podem rodar.", valor: "24 h", tom: "neutral" },
      { label: "Reprocessamento em falha", desc: "Repete a execução automaticamente em caso de erro.", valor: "Ativa", tom: "ok" },
      { label: "Notificações", desc: "Avisa o cockpit quando uma automação muda de estado.", valor: "Habilitadas", tom: "ok" },
    ],
  },
};

/** Modulos validos como rota dinamica (`/[modulo]/configuracoes-do-modulo`). */
export const MODULO_IDS: readonly ModuloId[] = ["ingestao", "cadastros", "automacoes"];

export function isModuloId(v: string): v is ModuloId {
  return (MODULO_IDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------
// Bandas (regioes verticais da tela)
// ---------------------------------------------------------------------

/** Ordem de exibicao das bandas na matriz de blocos. */
export const BAND_ORDER: readonly BlocoBanda[] = ["acao", "topo", "status", "ferramentas", "tabela"];

export const BAND_LABELS: Readonly<Record<BlocoBanda, string>> = {
  acao: "Ação",
  topo: "Cabeçalho",
  status: "Status",
  ferramentas: "Ferramentas",
  tabela: "Tabela",
};

/** Escopo canonico de um bloco: `<modulo>.<tela>.<bloco>`. */
export function blockEscopo(modulo: ModuloId, screenId: string, blockId: string): string {
  return `${modulo}.${screenId}.${blockId}`;
}
