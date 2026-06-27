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
import type { PillState } from "@/lib/status";
import { useWorkbench } from "./workbench-template";
import {
  WorkbenchSkeletonRows,
  WorkbenchTableEmpty,
  WorkbenchTableError,
  formatDateTime,
} from "./table-states";

/** Item capturado por uma coleta (projecao read-only de dados reais). */
export interface DadoColetado {
  id: string;
  titulo: string;
  origem: string;
  recurso: string | null;
  tipo: string;
  captadoEm: string | null;
  tamanho: string;
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
  emptyTitle: string;
  emptyDescription: string;
}

export function DadosTable({
  dados,
  loading,
  error,
  onRetry,
  onItemClick,
  emptyTitle,
  emptyDescription,
}: DadosTableProps) {
  const { isVisible } = useWorkbench();
  const showActions = isVisible("acoes-linha");

  // 7 colunas de dado + acoes (condicional).
  const colSpan = 7 + (showActions ? 1 : 0);

  return (
    <Table aria-label="Dados coletados">
      <TableHeader>
        <TableRow>
          <TableHead>Item</TableHead>
          <TableHead>Origem</TableHead>
          <TableHead>Recurso</TableHead>
          <TableHead>Tipo</TableHead>
          <TableHead>Captado em</TableHead>
          <TableHead className="text-right">Tamanho</TableHead>
          <TableHead>Status</TableHead>
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
              <TableCell className="font-medium">{dado.titulo}</TableCell>
              <TableCell>{dado.origem}</TableCell>
              <TableCell className="text-muted">{dado.recurso ?? "—"}</TableCell>
              <TableCell className="text-muted">{dado.tipo}</TableCell>
              <TableCell className="whitespace-nowrap text-muted">
                {formatDateTime(dado.captadoEm)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted">
                {dado.tamanho}
              </TableCell>
              <TableCell>
                <StatusPill state={dado.status.state} label={dado.status.label} />
              </TableCell>
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
