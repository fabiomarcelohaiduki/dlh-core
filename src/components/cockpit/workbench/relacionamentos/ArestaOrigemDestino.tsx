"use client";

// =====================================================================
// ArestaOrigemDestino - renderiza o par (origem, destino) em uma unica
// celula vertical: duas linhas, cada uma com bolinha cor + icone + label
// + id_composto curto. A bolinha usa a cor resolvida do no (vinda do
// backend via panorama).
//
// O id composto exibido e "<tipo>:<id_curto>" onde id_curto e o id
// truncado a 12 chars quando o id e longo demais (caso comum de UUIDs).
// =====================================================================

import {
  Box,
  Circle,
  DollarSign,
  FileText,
  Layers,
  Package,
  ShieldCheck,
  Tag,
  UserCircle,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { NoVisual } from "@/lib/api/relacionamentos-types";

export interface ArestaOrigemDestinoProps {
  origem: NoVisual;
  destino: NoVisual;
  className?: string;
}

/** Resolucao do icone por tipo. Mantida estavel para evitar flashes. */
function iconePorTipo(tipo: NoVisual["tipo"]) {
  switch (tipo) {
    case "aviso":
      return Circle;
    case "documento":
      return FileText;
    case "processo":
      return Workflow;
    case "pessoa":
      return UserCircle;
    case "produto":
      return Package;
    case "linha":
      return Box;
    case "sku":
      return Tag;
    case "preco":
      return DollarSign;
    case "politica":
      return ShieldCheck;
    case "cotacao_diretriz":
      return Layers;
    default:
      return Circle;
  }
}

/** Trunca um id para exibicao: ate 12 chars + "…" quando longo. */
function idCurto(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 12)}…`;
}

/** Item de no: bolinha + icone + label truncado + id curto. */
function LinhaNo({ no }: { no: NoVisual }) {
  const Icone = iconePorTipo(no.tipo);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className="size-2.5 flex-none rounded-full"
        style={{ background: no.cor }}
        aria-hidden="true"
      />
      <Icone className="size-3.5 flex-none text-muted" aria-hidden="true" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[12.5px] text-fg">{no.label}</span>
        <span className="truncate font-mono text-[10.5px] text-faint">
          {no.tipo}:{idCurto(no.id)}
        </span>
      </span>
    </span>
  );
}

export function ArestaOrigemDestino({
  origem,
  destino,
  className,
}: ArestaOrigemDestinoProps) {
  return (
    <span className={cn("flex flex-col gap-1.5", className)}>
      <LinhaNo no={origem} />
      <LinhaNo no={destino} />
    </span>
  );
}