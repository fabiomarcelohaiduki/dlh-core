"use client";

// =====================================================================
// ColetaRegistrosTable — tabela mestre-detalhe da guia "Dados" (substitui a
// DadosTable). Cada linha mestra (ColetaRegistrosRow) e UM registro coletado
// agrupado por (fonte, registro_origem_id), com:
//   - titulo_curto + expansor (<button> com aria-expanded/aria-controls);
//   - pill de fonte (.pill.src);
//   - captado_em via splitDateTime;
//   - 3 pills de contagem (documentos / pendentes / erros), com qtd_ignorado
//     no tooltip agregado;
//   - pill de status_indexacao_agregado (indexacaoAgregadoDescriptor);
//   - icone ExternalLink quando tem_link_publico (NUNCA para Nomus), como botao
//     proprio que nao propaga o clique para a expansao;
//   - botao "Triar aviso" SO para Effecti (disabled sem aviso_id).
//
// A expansao (ColetaRegistroDetalheExpansion) e uma linha-irma no mesmo tbody;
// MULTIPLAS linhas podem ficar abertas ao mesmo tempo. Paginacao por cursor
// server-side via CursorPager. Estados loading/empty/error reusam os
// componentes do workbench (WorkbenchSkeletonRows/Empty/Error).
//
// Componente de apresentacao: o conjunto expandido (Set) e o estado de cursor
// chegam por props do ColetaClient (sprint 7).
// =====================================================================

import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RegistroColetado } from "@/lib/api/coleta-registros";
import { indexacaoAgregadoDescriptor, origemLabel } from "@/lib/status";
import { StatusPill } from "@/components/cockpit/status-pill";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  WorkbenchSkeletonRows,
  WorkbenchTableEmpty,
  WorkbenchTableError,
  splitDateTime,
} from "./table-states";
import {
  CursorPager,
  type CursorPaginationProps,
} from "./table-pagination";
import { ColetaRegistroDetalheExpansion } from "./coleta-registro-detalhe-expansion";

/** Numero fixo de colunas da linha mestra (define o colSpan dos estados). */
const COL_SPAN = 6;

/** id estavel e seguro do painel expandido (alvo do aria-controls). */
function panelIdFor(idComposto: string): string {
  return `coleta-detalhe-${idComposto.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** Rotulo do "objeto" do registro para os aria-labels das acoes. */
function registroObjeto(registro: RegistroColetado): string {
  const c = registro.cabecalho;
  if (c.fonte === "effecti") return c.objeto || registro.tituloCurto;
  return registro.tituloCurto;
}

// ---------------------------------------------------------------------
// Pills de contagem da linha mestra.
// ---------------------------------------------------------------------

function ContagemPills({ registro }: { registro: RegistroColetado }) {
  const { qtdDocumentos, qtdPendentes, qtdErros, qtdIgnorado } = registro;
  const tooltip = `Documentos: ${qtdDocumentos} · Pendentes: ${qtdPendentes} · Erros: ${qtdErros} · Ignorados: ${qtdIgnorado}`;
  return (
    <span className="inline-flex items-center gap-1.5" title={tooltip}>
      <span className="pill neutral tabular-nums">{qtdDocumentos} docs</span>
      <span
        className={cn("pill tabular-nums", qtdPendentes > 0 ? "warn" : "neutral")}
      >
        {qtdPendentes} pend.
      </span>
      <span className={cn("pill tabular-nums", qtdErros > 0 ? "err" : "neutral")}>
        {qtdErros} {qtdErros === 1 ? "erro" : "erros"}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------
// Linha mestra + expansao (linha-irma).
// ---------------------------------------------------------------------

export interface ColetaRegistrosRowProps {
  registro: RegistroColetado;
  expanded: boolean;
  onToggleExpand: () => void;
  onCloseExpand: () => void;
  onTriarAviso: () => void;
}

export function ColetaRegistrosRow({
  registro,
  expanded,
  onToggleExpand,
  onCloseExpand,
  onTriarAviso,
}: ColetaRegistrosRowProps) {
  const panelId = panelIdFor(registro.idComposto);
  const objeto = registroObjeto(registro);
  const isEffecti = registro.fonte === "effecti";
  const isNomus = registro.fonte === "nomus";
  const { data, hora } = splitDateTime(registro.captadoEm);
  const indexacao = indexacaoAgregadoDescriptor(registro.statusIndexacaoAgregado);
  const mostrarLink = registro.temLinkPublico && !isNomus && Boolean(registro.linkOriginal);

  return (
    <>
      <TableRow data-selected={expanded || undefined}>
        {/* Registro: expansor + titulo. */}
        <TableCell className="font-medium">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={onToggleExpand}
            className="flex items-center gap-2 text-left text-fg transition-colors hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
            )}
            <span className="truncate">{registro.tituloCurto}</span>
          </button>
        </TableCell>

        {/* Fonte. */}
        <TableCell>
          <span className="pill src">{origemLabel(registro.fonte)}</span>
        </TableCell>

        {/* Captado em. */}
        <TableCell className="run-start">
          <strong>{data}</strong>
          {hora ? <span>{hora}</span> : null}
        </TableCell>

        {/* Contagens. */}
        <TableCell>
          <ContagemPills registro={registro} />
        </TableCell>

        {/* Status agregado de indexacao. */}
        <TableCell>
          <StatusPill state={indexacao.state} label={indexacao.label} />
        </TableCell>

        {/* Acoes: link externo + Triar aviso (Effecti). */}
        <TableCell className="text-right">
          <span className="inline-flex items-center justify-end gap-2">
            {mostrarLink ? (
              <a
                href={registro.linkOriginal as string}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Abrir registro original na fonte"
                onClick={(e) => e.stopPropagation()}
                className="grid size-7 place-items-center rounded-sm border border-border text-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
              >
                <ExternalLink aria-hidden="true" className="size-4" />
              </a>
            ) : null}
            {isEffecti ? (
              <Button
                type="button"
                variant="default"
                size="sm"
                aria-label={`Triar aviso ${objeto}`}
                title={
                  registro.avisoId
                    ? undefined
                    : "Aviso ainda nao disponivel para este registro"
                }
                disabled={!registro.avisoId}
                onClick={onTriarAviso}
              >
                Triar aviso
              </Button>
            ) : null}
          </span>
        </TableCell>
      </TableRow>

      {expanded ? (
        <TableRow>
          <TableCell colSpan={COL_SPAN} className="p-0">
            <ColetaRegistroDetalheExpansion
              registro={registro}
              panelId={panelId}
              onClose={onCloseExpand}
            />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------
// Tabela.
// ---------------------------------------------------------------------

export interface ColetaRegistrosTableProps {
  registros: RegistroColetado[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** Conjunto de idComposto expandidos (multiplas linhas simultaneas). */
  expanded: ReadonlySet<string>;
  onToggleExpand: (idComposto: string) => void;
  onCloseExpand: (idComposto: string) => void;
  onTriarAviso: (registro: RegistroColetado) => void;
  /** Estado de navegacao por cursor server-side (gerido pelo ColetaClient). */
  pagination: CursorPaginationProps;
  emptyTitle: string;
  emptyDescription: string;
}

export function ColetaRegistrosTable({
  registros,
  loading,
  error,
  onRetry,
  expanded,
  onToggleExpand,
  onCloseExpand,
  onTriarAviso,
  pagination,
  emptyTitle,
  emptyDescription,
}: ColetaRegistrosTableProps) {
  return (
    <>
      <Table aria-label="Registros coletados">
        <TableHeader>
          <TableRow>
            <TableHead>Registro</TableHead>
            <TableHead>Fonte</TableHead>
            <TableHead>Captado em</TableHead>
            <TableHead>Documentos</TableHead>
            <TableHead>Indexação</TableHead>
            <TableHead className="w-[1%] text-right">
              <span className="sr-only">Ações</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {error ? (
            <WorkbenchTableError
              title="Registros indisponíveis"
              message="Não foi possível listar os registros coletados. Verifique a conexão e tente novamente."
              onRetry={onRetry}
              colSpan={COL_SPAN}
            />
          ) : loading ? (
            <WorkbenchSkeletonRows cols={COL_SPAN} />
          ) : registros.length === 0 ? (
            <WorkbenchTableEmpty
              title={emptyTitle}
              description={emptyDescription}
              colSpan={COL_SPAN}
            />
          ) : (
            registros.map((registro) => (
              <ColetaRegistrosRow
                key={registro.idComposto}
                registro={registro}
                expanded={expanded.has(registro.idComposto)}
                onToggleExpand={() => onToggleExpand(registro.idComposto)}
                onCloseExpand={() => onCloseExpand(registro.idComposto)}
                onTriarAviso={() => onTriarAviso(registro)}
              />
            ))
          )}
        </TableBody>
      </Table>
      <CursorPager {...pagination} />
    </>
  );
}
