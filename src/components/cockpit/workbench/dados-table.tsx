"use client";

// =====================================================================
// DadosTable — tabela de Dados da Coleta (subpane "Dados"), read-only.
//
// Cada linha e um item efetivamente capturado por uma coleta (documento ou
// registro trazido de uma fonte). Como ainda nao ha endpoint dedicado de
// "dados coletados", a lista e projetada de forma HONESTA a partir das
// execucoes reais (useExecucoes) pelo ColetaClient — sem fabricar registros
// inexistentes. A coluna de acoes por linha respeita a visibilidade do bloco
// `acoes-linha` via useWorkbench(). Estados EC-09/10/11 ficam no <tbody>.
// =====================================================================

import { MoreHorizontal } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusPill } from "@/components/cockpit/status-pill";
import type { OrigemKey, PillState } from "@/lib/status";
import { useWorkbench } from "./workbench-template";
import type { TableColumn } from "./table-column";
import {
  WorkbenchSkeletonRows,
  WorkbenchTableEmpty,
  WorkbenchTableError,
  formatDateTime,
  splitDateTime,
} from "./table-states";

/** Item capturado por uma coleta (projecao read-only de dados reais). */
export interface DadoColetado {
  id: string;
  titulo: string;
  /** Rotulo exibivel da origem (ex.: "Effecti"). */
  origem: string;
  /** Chave normalizada da origem, usada pelo filtro por fonte. */
  origemKey: OrigemKey;
  recurso: string | null;
  captadoEm: string | null;
  /** Quantidade de itens trazidos pela coleta (novos + alterados). */
  itens: string;
  status: { state: PillState; label: string };
  /** Sinaliza item obsoleto/arquivado (EC-13: aviso honesto no ActionModal). */
  obsoleto?: boolean;
}

export interface DadosTableProps {
  dados: DadoColetado[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onItemClick: (dado: DadoColetado) => void;
  /** Ids das colunas ocultas (controle da toolbar). */
  hidden?: ReadonlySet<string>;
  emptyTitle: string;
  emptyDescription: string;
}

/** Colunas de dado da tabela de Dados (fonte unica p/ render + toolbar). */
export const DADOS_COLUMNS: readonly TableColumn<DadoColetado>[] = [
  {
    id: "titulo",
    label: "Item",
    cellClass: "font-medium",
    cell: (d) => d.titulo,
    text: (d) => d.titulo,
  },
  {
    id: "origem",
    label: "Origem",
    cell: (d) => <span className="pill src">{d.origem}</span>,
    text: (d) => d.origem,
  },
  {
    id: "recurso",
    label: "Recurso",
    cellClass: "text-muted",
    cell: (d) => d.recurso ?? "—",
    text: (d) => d.recurso ?? "",
  },
  {
    id: "captadoEm",
    label: "Captado em",
    cellClass: "run-start",
    cell: (d) => {
      const { data, hora } = splitDateTime(d.captadoEm);
      return (
        <>
          <strong>{data}</strong>
          {hora ? <span>{hora}</span> : null}
        </>
      );
    },
    text: (d) => formatDateTime(d.captadoEm),
  },
  {
    id: "itens",
    label: "Itens",
    headClass: "text-right",
    cellClass: "text-right tabular-nums text-muted",
    cell: (d) => d.itens,
    text: (d) => d.itens,
  },
  {
    id: "status",
    label: "Status",
    cell: (d) => <StatusPill state={d.status.state} label={d.status.label} />,
    text: (d) => d.status.label,
  },
];

export function DadosTable({
  dados,
  loading,
  error,
  onRetry,
  onItemClick,
  hidden,
  emptyTitle,
  emptyDescription,
}: DadosTableProps) {
  const { isVisible } = useWorkbench();
  const showActions = isVisible("acoes-linha");

  const columns = DADOS_COLUMNS.filter((c) => !hidden?.has(c.id));
  const colSpan = columns.length + (showActions ? 1 : 0);

  return (
    <Table aria-label="Dados coletados">
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHead key={col.id} className={col.headClass}>
              {col.label}
            </TableHead>
          ))}
          {showActions ? (
            <TableHead data-block="acoes-linha" className="w-[1%] text-right">
              <span className="sr-only">Ações</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {error ? (
          <WorkbenchTableError
            title="Dados indisponíveis"
            message="Não foi possível listar os dados coletados. Verifique a conexão e tente novamente."
            onRetry={onRetry}
            colSpan={colSpan}
          />
        ) : loading ? (
          <WorkbenchSkeletonRows cols={colSpan} />
        ) : dados.length === 0 ? (
          <WorkbenchTableEmpty
            title={emptyTitle}
            description={emptyDescription}
            colSpan={colSpan}
          />
        ) : (
          dados.map((dado) => (
            <TableRow
              key={dado.id}
              data-clickable=""
              onClick={() => onItemClick(dado)}
            >
              {columns.map((col) => (
                <TableCell key={col.id} className={col.cellClass}>
                  {col.cell(dado)}
                </TableCell>
              ))}
              {showActions ? (
                <TableCell
                  data-block="acoes-linha"
                  className="text-right"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    aria-label={`Ações de ${dado.titulo}`}
                    onClick={() => onItemClick(dado)}
                    className="grid size-7 place-items-center rounded-sm border border-border text-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
                  >
                    <MoreHorizontal aria-hidden="true" className="size-4" />
                  </button>
                </TableCell>
              ) : null}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
