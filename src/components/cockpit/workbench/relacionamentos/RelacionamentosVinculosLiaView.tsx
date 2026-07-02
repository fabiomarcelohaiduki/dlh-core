"use client";

// =====================================================================
// RelacionamentosVinculosLiaView - sub-secao C do painel de
// Relacionamentos: lista vinculos inferidos pela Lia
// (vinculos_inferidos_lia) com filtros, badge de "pronta para
// promocao" e botoes por linha.
//
// Estrutura:
//   1) Card de resumo explicando o ciclo Lia -> humano + o badge
//      amarelo de "Pronta para promocao";
//   2) VinculoFiltros (controlado) - 4 campos + botao limpar;
//   3) Tabela com colunas: descricao, contador_uso, contador_2caminhos,
//      origem, status (badge), regra_macro_id, updated_at;
//   4) Skeleton de 5 linhas durante refetch + empty-state honesto;
//   5) Botoes Aprovar/Rejeitar/Editar RENDERIZADOS DESABILITADOS para
//      manter esta lista como leitura. As acoes funcionais ficam na
//      sub-aba "Aprovacoes pendentes".
//
// A badge amarela "Pronta para promocao" aparece quando
//   contador_uso >= uso_minimo_promocao_alternativa
//   OR (
//     contador_uso >= uso_minimo_promocao
//     AND contador_2caminhos >= dois_caminhos_minimo
//   )
// (espelha a logica da config singleton; ambos sao inteiros >= 0).
//
// O filtro de contador_uso_min/max e aplicado CLIENT-SIDE em cima da
// pagina retornada (o backend nao expoe esses parametros - o spec
// atual de GET /relacionamentos-vinculos-lia aceita apenas
// status/origem/limit/offset).
// =====================================================================

import { useMemo, useState } from "react";
import { Inbox, Pencil, RefreshCcw, Sparkles, Trash2 } from "lucide-react";
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
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { formatDateTimeFull } from "@/lib/format";
import { ApiError } from "@/lib/api/client";
import {
  useRelacionamentosVinculosLia,
} from "@/hooks/relacionamentos/use-relacionamentos-vinculos-lia";
import { useRelacionamentosConfig } from "@/hooks/relacionamentos/use-relacionamentos-config";
import type {
  RelacionamentoVinculoOrigem,
  RelacionamentoVinculoStatus,
  VinculoLia,
} from "@/lib/api/relacionamentos-types";
import {
  VinculoFiltros,
  VINCULO_FILTROS_INICIAL,
  type VinculoFiltrosValue,
  type VinculoFiltroStatus,
  type VinculoFiltroOrigem,
} from "./VinculoFiltros";

// ---------------------------------------------------------------------
// Mensagens / labels em PT-BR.
// ---------------------------------------------------------------------

const STATUS_LABEL: Record<RelacionamentoVinculoStatus, string> = {
  rascunho: "Rascunho",
  ativo: "Ativo",
  descartado: "Descartado",
};

const ORIGEM_LABEL: Record<RelacionamentoVinculoOrigem, string> = {
  lia: "Lia",
  humano: "Humano",
};

const TOOLTIP_USAR_APROVACOES =
  "Use a sub-aba Aprovações pendentes para aprovar, rejeitar ou editar.";

// ---------------------------------------------------------------------
// Helpers locais.
// ---------------------------------------------------------------------

/** Status do filtro -> status real enviado ao backend (omitido quando "todos"). */
function toServerStatus(
  status: VinculoFiltroStatus,
): RelacionamentoVinculoStatus | undefined {
  return status === "todos" ? undefined : status;
}

/** Origem do filtro -> origem real enviada ao backend (omitido quando "todos"). */
function toServerOrigem(
  origem: VinculoFiltroOrigem,
): RelacionamentoVinculoOrigem | undefined {
  return origem === "todos" ? undefined : origem;
}

/**
 * Parse tolerante do contador_uso_min/max (string do input) -> number
 * ou undefined. Strings invalidas viram undefined (sem filtro).
 */
function parseContadorLimite(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/** Decide se um vinculo esta pronto para promocao (regra humana nova). */
function isProntaParaPromocao(
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
// Skeleton (5 linhas x 7 colunas).
// ---------------------------------------------------------------------

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, r) => (
        <TableRow key={`vinculo-skel-${r}`} aria-hidden="true">
          {Array.from({ length: 7 }).map((__, c) => (
            <TableCell key={c}>
              <span
                className="block h-3 animate-pulse rounded-sm bg-surface-3"
                style={{ width: c === 0 ? 80 : `${40 + ((r + c) % 4) * 14}%` }}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function RelacionamentosVinculosLiaView() {
  const [filtros, setFiltros] = useState<VinculoFiltrosValue>(
    VINCULO_FILTROS_INICIAL,
  );
  const { toast } = useToast();

  // Parametros de listagem (apenas status/origem vao para o backend).
  const listaParams = useMemo(
    () => ({
      status: toServerStatus(filtros.status),
      origem: toServerOrigem(filtros.origem),
      limit: 200,
    }),
    [filtros.status, filtros.origem],
  );

  const { data, isLoading, isError, error, refetch } =
    useRelacionamentosVinculosLia(listaParams);

  // Config singleton -> thresholds de promocao: X por uso sozinho OU Y uso + Z dois caminhos.
  const config = useRelacionamentosConfig();

  const thresholds = useMemo(
    () => ({
      usoSolo: config.data?.uso_minimo_promocao_alternativa ?? 0,
      usoCom2Caminhos: config.data?.uso_minimo_promocao ?? 0,
      doisCaminhos: config.data?.dois_caminhos_minimo ?? 0,
    }),
    [config.data],
  );

  // Filtragem adicional client-side (contador_uso_min/max).
  const itensFiltrados = useMemo(() => {
    const itens = data?.items ?? [];
    const min = parseContadorLimite(filtros.contador_uso_min);
    const max = parseContadorLimite(filtros.contador_uso_max);
    if (min === undefined && max === undefined) return itens;
    return itens.filter((v) => {
      const uso = v.contador_uso ?? 0;
      if (min !== undefined && uso < min) return false;
      if (max !== undefined && uso > max) return false;
      return true;
    });
  }, [data?.items, filtros.contador_uso_min, filtros.contador_uso_max]);

  function handleClear() {
    setFiltros(VINCULO_FILTROS_INICIAL);
  }

  function handleClickIndisponivel(acao: string) {
    // Botao esta disabled; este handler existe apenas como safety net
    // caso o usuario force um clique via teclado antes do browser
    // reconhecer o disabled. Mantemos feedback honesto.
    toast({
      title: `Acao "${acao}" ainda nao disponivel`,
      description: TOOLTIP_USAR_APROVACOES,
      variant: "info",
    });
  }

  return (
    <>
      {/* Card de resumo */}
      <section
        data-card="info-vinculos-lia"
        className="flex flex-col gap-2 rounded-md border border-border bg-surface-2/40 p-4"
      >
        <p className="m-0 text-[13px] text-muted">
          <strong className="text-fg">Como funcionam.</strong> A Lia observa o
          grafo durante o trabalho diario e propoe vinculos entre nos. Cada
          vinculo entra como <strong>rascunho</strong>; ao atingir os limites
          de uso (definidos na config da org) ele recebe a badge{" "}
          <strong>Pronta para promocao</strong> e pode virar uma regra humana
          permanente via o fluxo de <strong>Aprovacoes pendentes</strong>.
        </p>
        <p className="m-0 text-[12.5px] text-warn">
          <strong>Badge amarela:</strong> uso &gt;= {thresholds.usoSolo} OU
          uso &gt;= {thresholds.usoCom2Caminhos} E 2 caminhos &gt;= {" "}
          {thresholds.doisCaminhos}. Ajuste os limites em{" "}
          <em>Parametros</em>.
        </p>
      </section>

      {/* Filtros */}
      <VinculoFiltros
        value={filtros}
        onChange={setFiltros}
        onClear={handleClear}
        disabled={isLoading}
      />

      {/* Toolbar secundaria */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-faint" data-info="contador-vinculos">
          {isLoading
            ? "Carregando vinculos…"
            : `${itensFiltrados.length} ${
                itensFiltrados.length === 1 ? "vinculo" : "vinculos"
              }${itensFiltrados.length !== (data?.items.length ?? 0) ? ` (de ${data?.items.length ?? 0})` : ""}`}
        </span>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => refetch()}
          aria-label="Recarregar lista de vinculos inferidos pela Lia"
          disabled={isLoading}
          data-btn="recarregar-vinculos"
        >
          <RefreshCcw aria-hidden="true" />
          <span>Recarregar</span>
        </Button>
      </div>

      {/* Tabela */}
      {isError ? (
        <WidgetError
          title="Nao foi possivel carregar"
          message={humanizarErro(error)}
          onRetry={() => refetch()}
        />
      ) : (
        <Table density="comfortable">
          <TableHeader>
            <TableRow>
              <TableHead>Descricao</TableHead>
              <TableHead className="w-[110px] text-right">Uso</TableHead>
              <TableHead className="w-[120px] text-right">2 caminhos</TableHead>
              <TableHead className="w-[110px]">Origem</TableHead>
              <TableHead className="w-[130px]">Status</TableHead>
              <TableHead className="w-[180px]">Regra macro</TableHead>
              <TableHead className="w-[150px]">Atualizada</TableHead>
              <TableHead className="w-[220px] text-right">Acoes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows />
            ) : itensFiltrados.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="!py-12 text-center">
                  <div
                    data-empty="vinculos-lia"
                    className="flex flex-col items-center gap-2 text-muted"
                  >
                    <Inbox className="size-8" aria-hidden="true" />
                    <p className="text-[13px] font-semibold text-fg">
                      Nenhum vinculo encontrado com os filtros atuais
                    </p>
                    <p className="text-[12.5px] text-muted">
                      Ajuste os filtros acima ou aguarde a proxima rodada de inferencia da Lia.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              itensFiltrados.map((vinculo) => {
                const pronta = isProntaParaPromocao(vinculo, thresholds);
                return (
                  <TableRow
                    key={vinculo.id}
                    data-row-vinculo={vinculo.id}
                    data-pronta-promocao={pronta ? "true" : "false"}
                    data-status={vinculo.status}
                  >
                    <TableCell>
                      <span className="line-clamp-2 text-[12.5px] text-fg">
                        {vinculo.descricao}
                      </span>
                      {pronta ? (
                        <span className="mt-1 inline-flex">
                          <Pill variant="warn" dot>
                            <Sparkles className="mr-0.5 size-3" aria-hidden="true" />
                            Pronta para promocao
                          </Pill>
                        </span>
                      ) : null}
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
                    <TableCell>
                      <Pill variant={pillVariantStatus(vinculo.status)}>
                        {STATUS_LABEL[vinculo.status]}
                      </Pill>
                    </TableCell>
                    <TableCell className="font-mono text-[11.5px] text-muted">
                      {vinculo.regra_macro_id ? (
                        <span title={vinculo.regra_macro_id}>
                          {vinculo.regra_macro_id.slice(0, 8)}…
                        </span>
                      ) : (
                        <span className="text-faint">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-[12px] text-muted">
                      {formatDateTimeFull(vinculo.updated_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div
                        className="inline-flex items-center gap-1"
                        data-actions="vinculo-lia"
                      >
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled
                          aria-label={`Aprovar vinculo ${vinculo.id}`}
                          title={TOOLTIP_USAR_APROVACOES}
                          data-btn="aprovar-vinculo"
                          onClick={() => handleClickIndisponivel("aprovar")}
                        >
                          <Sparkles aria-hidden="true" />
                          <span>Aprovar</span>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled
                          aria-label={`Rejeitar vinculo ${vinculo.id}`}
                          title={TOOLTIP_USAR_APROVACOES}
                          data-btn="rejeitar-vinculo"
                          onClick={() => handleClickIndisponivel("rejeitar")}
                        >
                          <Trash2 aria-hidden="true" />
                          <span>Rejeitar</span>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled
                          aria-label={`Editar vinculo ${vinculo.id}`}
                          title={TOOLTIP_USAR_APROVACOES}
                          data-btn="editar-vinculo"
                          onClick={() => handleClickIndisponivel("editar")}
                          className={cn("opacity-60")}
                        >
                          <Pencil aria-hidden="true" />
                          <span>Editar</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      )}
    </>
  );
}

// ---------------------------------------------------------------------
// Helpers visuais.
// ---------------------------------------------------------------------

function pillVariantStatus(
  status: RelacionamentoVinculoStatus,
): "ok" | "warn" | "danger" | "accent" | "neutral" {
  if (status === "ativo") return "ok";
  if (status === "descartado") return "danger";
  if (status === "rascunho") return "warn";
  return "neutral";
}

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
