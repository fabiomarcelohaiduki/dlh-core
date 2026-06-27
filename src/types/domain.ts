// =====================================================================
// Tipos de dominio da Fase 0 (Cockpit LionClaw) em camelCase.
// Modelo voltado a UI/hooks — desacoplado das Row snake_case do Postgres
// (ver src/types/database.ts). Convencao camelCase identica a
// src/lib/api/types.ts. Mapeadores Row<->Domain vivem na camada de API.
// =====================================================================

import type {
  AreaInicial,
  BlocoBanda,
  BlocoTipo,
  Densidade,
  OrgPapel,
} from "./database";

export type { AreaInicial, BlocoBanda, BlocoTipo, Densidade, OrgPapel };

/** Tema visual do catalogo global (SPEC 2.1.1). */
export interface Tema {
  id: string;
  nome: string;
  /** Cor hex de marca (acento). */
  acento: string;
  /** Cor hex de fundo. */
  fundo: string;
  /** Cor hex de texto. */
  texto: string;
  createdAt: string;
}

/** Preferencias do usuario na organizacao (SPEC 2.1.4). Singleton por user/org. */
export interface Configuracao {
  id: string;
  userId: string;
  orgId: string;
  areaInicial: AreaInicial | null;
  linhasCompactas: boolean;
  destacarPendencias: boolean;
  /** null = tema padrao (LionClaw). */
  temaId: string | null;
  densidade: Densidade;
  reduzirMovimento: boolean;
  highlightPendencias: boolean;
  defaultArea: AreaInicial | null;
  tz: string;
  dateFmt: string;
  numFmt: string;
  notifyAlerts: boolean;
  notifyIngest: boolean;
  notifyDeadline: boolean;
  notifyDigest: boolean;
  autoSync: boolean;
  /** Frequencia de sync em minutos (5 | 15 | 30 | 60). */
  syncFreq: number;
  /** Timeout de sessao em minutos (0 desativa). */
  sessionTimeout: number;
  sessionWarn: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Configuracao reutilizavel por escopo hierarquico (SPEC 2.1.9). */
export interface BlocoConfig {
  id: string;
  userId: string;
  orgId: string;
  /** Path hierarquico (ex.: ingestao.coleta.agendamento.lote). */
  escopo: string;
  tipo: BlocoTipo;
  visivel: boolean;
  ordem: number;
  banda: BlocoBanda | null;
  valor: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
