"use client";

// =====================================================================
// RelacionamentosAprovacoesPendentesView - sub-secao D do painel de
// Relacionamentos: lista filtrada de vinculos da Lia que ja atingiram
// os limiares de promocao e estao prontos para virar regra humana
// permanente (aprovar) ou serem descartados (rejeitar) ou ajustados
// (editar).
//
// Regra de filtro (espelha o backend, mas aplicada client-side em cima
// da lista retornada pela sub-secao C):
//
//   status === 'proposta'
//   AND (
//     contador_uso >= uso_minimo_promocao_alternativa
//     OR (
//       contador_uso >= uso_minimo_promocao
//       AND contador_2caminhos >= dois_caminhos_minimo
//     )
//   )
//
// Estrutura:
//   1) Card de resumo com a politica de promocao (espelha o card da
//      sub-secao C, mas apontando para esta acao);
//   2) Toolbar com contador + botao Recarregar;
//   3) Tabela com colunas: descricao, contador_uso, contador_2caminhos,
//      origem, acoes (Aprovar / Rejeitar / Editar);
//   4) Skeleton de 5 linhas enquanto carrega + empty-state honesto;
//   5) Modal de aprovacao/rejeicao/edicao controlado por estado local.
//
// O modal e' o AprovacaoModal compartilhado (sprint-010 do roadmap da
// feature). Os botoes da linha abrem o modal no modo apropriado.
// =====================================================================

import { useMemo, useState } from "react";
import {
  Check,
  Inbox,
  Pencil,
  RefreshCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WidgetError } from "@/components/cockpit/widget-error";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api/client";
import { useRelacionamentosVinculosLia } from "@/hooks/relacionamentos/use-relacionamentos-vinculos-lia";
import { useRelacionamentosConfig } from "@/hooks/relacionamentos/use-relacionamentos-config";
import type { VinculoLia } from "@/lib/api/relacionamentos-types";
import {
  AprovacaoModal,
  type AprovacaoModo,
} from "./AprovacaoModal";

// ---------------------------------------------------------------------
// Helpers visuais e labels em PT-BR.
// ---------------------------------------------------------------------

const ORIGEM_LABEL = {
  lia: "Lia",
  humano: "Humano",
} as const;

// ---------------------------------------------------------------------
// Skeleton de carregamento (5 linhas x 5 colunas).
// ---------------------------------------------------------------------

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, r) => (
        <TableRow key={`aprov-skel-${r}`} aria-hidden="true">
          {Array.from({ length: 5 }).map((__, c) => (
            <TableCell key={c}>
              <span
                className="block h-3 animate-pulse rounded-sm bg-surface-3"
                style={{ width: c === 0 ? 60 : `${40 + ((r + c) % 4) * 14}%` }}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------
// Filtro client-side: aplica os thresholds da config da org.
// ---------------------------------------------------------------------

/**
 * Decide se um vinculo (ja em status='proposta') atinge o limiar de
 * promocao configurado pela org. Logica intencionalmente client-side
 * porque o endpoint de listagem nao expoe thresholds - esta view e' a
 * especializada em "pronto para virar regra".
 */
function isProntoParaPromocao(
  vinculo: VinculoLia,
  thresholds: { usoSolo: number; usoCom2Caminhos: number; doisCaminhos: number },
): boolean {
  const uso = vinculo.contador_uso ?? 0;
  const dois = vinculo.contador_2caminhos ?? 0;
  return (
    uso >= thresholds.usoSolo ||
    (uso >= thresholds.usoCom2Caminhos && dois >= thresholds.doisCaminhos)
  );
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

/** Estado do modal controlado pela view. */
type ModalState =
  | { open: false; vinculo: null; acao: AprovacaoModo }
  | { open: true; vinculo: VinculoLia; acao: AprovacaoModo };

export function RelacionamentosAprovacoesPendentesView() {
  const [modal, setModal] = useState<ModalState>({
    open: false,
    vinculo: null,
    acao: "aprovar",
  });

  // Lista completa de propostas (sem threshold no backend). Filtraremos
  // client-side com base na config singleton.
  const listaParams = useMemo(
    () => ({ status: "proposta" as const, limit: 500 }),
    [],
  );

  const { data, isLoading, isError, error, refetch } =
    useRelacionamentosVinculosLia(listaParams);

  const config = useRelacionamentosConfig();

  const thresholds = useMemo(
    () => ({
      usoSolo: config.data?.uso_minimo_promocao_alternativa ?? 0,
      usoCom2Caminhos: config.data?.uso_minimo_promocao ?? 0,
      doisCaminhos: config.data?.dois_caminhos_minimo ?? 0,
    }),
    [config.data],
  );

  // Filtragem client-side: mantem apenas os que atingem pelo menos
  // um dos dois limiares.
  const itensPendentes = useMemo(() => {
    const itens = data?.items ?? [];
    return itens.filter((v) => isProntoParaPromocao(v, thresholds));
  }, [data?.items, thresholds]);

  function handleOpen(vinculo: VinculoLia, acao: AprovacaoModo) {
    setModal({ open: true, vinculo, acao });
  }

  function handleClose() {
    setModal({ open: false, vinculo: null, acao: "aprovar" });
  }

  return (
    <>
      {/* Card de resumo explicando o que e' "pronto para promocao" */}
      <section
        data-card="info-aprovacoes"
        className="flex flex-col gap-2 rounded-md border border-border bg-surface-2/40 p-4"
      >
        <p className="m-0 text-[13px] text-muted">
          <strong className="text-fg">O que aparece aqui.</strong> Vinculos
          inferidos pela Lia que ja atingiram os limites de uso definidos pela
          org. Cada item pode virar uma regra humana permanente
          (<strong>Aprovar</strong>), ser descartado com motivo
          (<strong>Rejeitar</strong>) ou ter a descricao e a regra previstas
          ajustadas antes da decisao (<strong>Editar</strong>).
        </p>
        <p className="m-0 text-[12.5px] text-warn">
          <strong>Limite atual:</strong> uso &ge; {thresholds.usoSolo} OU uso
          &ge; {thresholds.usoCom2Caminhos} E 2 caminhos &ge;{" "}
          {thresholds.doisCaminhos}. Ajuste em{" "}
          <em>Parametros</em>.
        </p>
      </section>

      {/* Toolbar secundaria */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className="text-[12px] text-faint"
          data-info="contador-aprovacoes"
        >
          {isLoading
            ? "Carregando aprovações…"
            : `${itensPendentes.length} ${
                itensPendentes.length === 1 ? "item pendente" : "itens pendentes"
              }${
                itensPendentes.length !== (data?.items.length ?? 0)
                  ? ` (de ${data?.items.length ?? 0} propostas)`
                  : ""
              }`}
        </span>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => refetch()}
          aria-label="Recarregar lista de aprovações pendentes"
          disabled={isLoading}
          data-btn="recarregar-aprovacoes"
        >
          <RefreshCcw aria-hidden="true" />
          <span>Recarregar</span>
        </Button>
      </div>

      {/* Tabela */}
      {isError ? (
        <WidgetError
          title="Não foi possível carregar"
          message={humanizarErro(error)}
          onRetry={() => refetch()}
        />
      ) : (
        <Table density="comfortable">
          <TableHeader>
            <TableRow>
              <TableHead>Descrição</TableHead>
              <TableHead className="w-[110px] text-right">Uso</TableHead>
              <TableHead className="w-[120px] text-right">2 caminhos</TableHead>
              <TableHead className="w-[110px]">Origem</TableHead>
              <TableHead className="w-[260px] text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows />
            ) : itensPendentes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="!py-12 text-center">
                  <div
                    data-empty="aprovacoes-pendentes"
                    className="flex flex-col items-center gap-2 text-muted"
                  >
                    <Inbox className="size-8" aria-hidden="true" />
                    <p className="text-[13px] font-semibold text-fg">
                      Nenhuma aprovação pendente
                    </p>
                    <p className="text-[12.5px] text-muted">
                      Os vinculos da Lia aparecerao aqui quando atingirem os
                      limites de uso definidos em Parametros.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              itensPendentes.map((vinculo) => (
                <TableRow
                  key={vinculo.id}
                  data-row-aprovacao={vinculo.id}
                  data-status={vinculo.status}
                >
                  <TableCell>
                    <span className="line-clamp-2 text-[12.5px] text-fg">
                      {vinculo.descricao}
                    </span>
                    <span className="mt-1 inline-flex">
                      <Pill variant="warn" dot>
                        <Sparkles className="mr-0.5 size-3" aria-hidden="true" />
                        Pronto para promoção
                      </Pill>
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-[12px] text-muted">
                    {vinculo.contador_uso ?? 0}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[12px] text-muted">
                    {vinculo.contador_2caminhos ?? 0}
                  </TableCell>
                  <TableCell>
                    <Pill variant={vinculo.origem === "humano" ? "accent" : "neutral"}>
                      {ORIGEM_LABEL[vinculo.origem]}
                    </Pill>
                  </TableCell>
                  <TableCell className="text-right">
                    <div
                      className="inline-flex items-center gap-1"
                      data-actions="aprovacao-pendente"
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={() => handleOpen(vinculo, "aprovar")}
                        aria-label={`Aprovar vínculo ${vinculo.id}`}
                        data-btn="aprovar-aprovacao"
                      >
                        <Sparkles aria-hidden="true" />
                        <span>Aprovar</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleOpen(vinculo, "rejeitar")}
                        aria-label={`Rejeitar vínculo ${vinculo.id}`}
                        data-btn="rejeitar-aprovacao"
                      >
                        <Trash2 aria-hidden="true" />
                        <span>Rejeitar</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleOpen(vinculo, "editar")}
                        aria-label={`Editar vínculo ${vinculo.id}`}
                        data-btn="editar-aprovacao"
                        className={cn("opacity-80")}
                      >
                        <Pencil aria-hidden="true" />
                        <span>Editar</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      {/* Modal de decisao (controlado) */}
      <AprovacaoModal
        open={modal.open}
        onClose={handleClose}
        vinculo={modal.vinculo}
        acaoInicial={modal.acao}
      />
    </>
  );
}

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

function humanizarErro(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "Recurso nao encontrado.";
    if (err.status === 409)
      return "Conflito com o estado atual dos vinculos.";
    if (err.status === 422)
      return "Filtros invalidos: revise os valores informados.";
    return err.message || "Falha na operacao. Tente novamente.";
  }
  return "Falha na operacao. Tente novamente.";
}

// Silencia o linter para o Check import (reusado indiretamente via
// AprovacaoModal). Mantem a interface consistente com outras tabelas
// do painel que importam Check para a acao primaria.
void Check;
