"use client";

// =====================================================================
// RelacionamentosRegrasSemanticasView - sub-secao "Regras semanticas" do
// painel de Relacionamentos (F4). Substitui a antiga "Parametros".
//
// 2 blocos + editor de abreviacoes:
//   A) "O que pode ser cruzado" (candidatos)
//      - vinculos inferidos AUDITAVEIS (vinculos_inferidos_lia). Colunas:
//        descricao, origem, data_origem, contexto_origem, status + acoes.
//      - ativar/desativar 1 candidato. Desativar EXIGE motivo (modal).
//      - paginacao KEYSET ("Carregar mais"), sem truncamento silencioso.
//      - empty-state: "Nenhum candidato cadastrado ainda."
//   B) Editor de abreviacoes/cores por tipo (AbreviacoesEditor).
//   C) "Ajustes tecnicos da Lia" (config_relacionamentos) RENDER-ONLY, com
//      badge "interno" (RNF-15) — nunca editavel por esta UI.
// =====================================================================

import { useState } from "react";
import {
  CircleCheck,
  CircleSlash,
  Inbox,
  Loader2,
  Lock,
  RefreshCcw,
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
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { WidgetError } from "@/components/cockpit/widget-error";
import { useToast } from "@/components/ui/toast";
import { formatDateTimeFull } from "@/lib/format";
import { ApiError } from "@/lib/api/client";
import {
  useAcaoRegraSemantica,
  useRelacionamentosRegrasSemanticas,
} from "@/hooks/relacionamentos";
import type {
  AjustesTecnicosLia,
  RegraSemanticaCandidato,
  RelacionamentoVinculoOrigem,
  RelacionamentoVinculoStatus,
} from "@/lib/api/relacionamentos-types";
import { AbreviacoesEditor } from "./AbreviacoesEditor";

// ---------------------------------------------------------------------
// Labels PT-BR.
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

/** Rotulos dos campos render-only do bloco de ajustes tecnicos. */
const AJUSTE_LABEL: Record<string, string> = {
  cap_por_grafo: "Teto de nos por grafo",
  clustering_threshold_nos: "Limiar de clustering",
  tipo_default_panorama: "Grafo default do panorama",
  cap_vizinhanca: "Teto da vizinhanca",
  uso_minimo_promocao: "Uso minimo p/ promocao",
  uso_minimo_promocao_alternativa: "Uso minimo (alternativa)",
  dois_caminhos_minimo: "2 caminhos minimo",
  profundidade_max_lia: "Profundidade max (Lia)",
  profundidade_default_panorama: "Profundidade default",
};

function humanizarErro(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Este bloco e somente leitura.";
    if (err.status === 404) return "Candidato nao encontrado.";
    if (err.status === 409) return "Conflito com o estado atual.";
    if (err.status === 422) return "Dados invalidos: revise o motivo informado.";
    return err.message || "Falha na operacao. Tente novamente.";
  }
  return "Falha na operacao. Tente novamente.";
}

function pillVariantStatus(
  status: RelacionamentoVinculoStatus,
): "ok" | "warn" | "danger" | "accent" | "neutral" {
  if (status === "ativo") return "ok";
  if (status === "descartado") return "danger";
  if (status === "rascunho") return "warn";
  return "neutral";
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function RelacionamentosRegrasSemanticasView() {
  const { toast } = useToast();
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetching,
  } = useRelacionamentosRegrasSemanticas();
  const acao = useAcaoRegraSemantica();

  // Modal de desativacao (exige motivo).
  const [desativarAlvo, setDesativarAlvo] = useState<RegraSemanticaCandidato | null>(null);
  const [motivo, setMotivo] = useState("");

  function handleAtivar(candidato: RegraSemanticaCandidato) {
    acao.mutate(
      { bloco: "candidatos", operacao: "ativar", item_id: candidato.id },
      {
        onSuccess: () =>
          toast({ title: "Candidato ativado", variant: "ok" }),
        onError: (err) =>
          toast({
            title: "Nao foi possivel ativar",
            description: humanizarErro(err),
            variant: "danger",
          }),
      },
    );
  }

  function abrirDesativar(candidato: RegraSemanticaCandidato) {
    setDesativarAlvo(candidato);
    setMotivo("");
  }

  function confirmarDesativar() {
    if (!desativarAlvo || motivo.trim() === "") return;
    acao.mutate(
      {
        bloco: "candidatos",
        operacao: "desativar",
        item_id: desativarAlvo.id,
        motivo: motivo.trim(),
      },
      {
        onSuccess: () => {
          toast({ title: "Candidato desativado", variant: "ok" });
          setDesativarAlvo(null);
          setMotivo("");
        },
        onError: (err) =>
          toast({
            title: "Nao foi possivel desativar",
            description: humanizarErro(err),
            variant: "danger",
          }),
      },
    );
  }

  const candidatos = data.candidatos;
  const ajustes = data.ajustes_tecnicos_lia;

  return (
    <>
      {/* Card de contexto */}
      <section
        data-card="info-regras-semanticas"
        className="flex flex-col gap-2 rounded-md border border-border bg-surface-2/40 p-4"
      >
        <p className="m-0 text-[13px] text-muted">
          <strong className="text-fg">Regras semanticas.</strong> Reveja o que a
          Lia pode cruzar (candidatos auditaveis), ajuste as abreviacoes e cores
          usadas na legenda do grafo e consulte os limiares tecnicos que a Lia
          aplica. Os limiares sao <strong>somente leitura</strong> nesta tela.
        </p>
      </section>

      {/* Bloco A - candidatos */}
      <section
        data-card="candidatos"
        className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-[14px] font-semibold text-fg">O que pode ser cruzado</h3>
            <p className="m-0 text-[12.5px] text-muted">
              Candidatos que a Lia observou. Ative para permitir o cruzamento ou
              desative (com motivo) para bloquea-lo.
            </p>
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Recarregar candidatos"
            data-btn="recarregar-candidatos"
          >
            <RefreshCcw aria-hidden="true" />
            <span>Recarregar</span>
          </Button>
        </header>

        {isError ? (
          <WidgetError
            title="Nao foi possivel carregar"
            message={humanizarErro(error)}
            onRetry={() => refetch()}
          />
        ) : (
          <>
            <Table density="comfortable">
              <TableHeader>
                <TableRow>
                  <TableHead>Descricao</TableHead>
                  <TableHead className="w-[110px]">Origem</TableHead>
                  <TableHead className="w-[160px]">Data de origem</TableHead>
                  <TableHead className="w-[220px]">Contexto de origem</TableHead>
                  <TableHead className="w-[120px]">Status</TableHead>
                  <TableHead className="w-[190px] text-right">Acoes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <SkeletonRows />
                ) : candidatos.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="!py-12 text-center">
                      <div
                        data-empty="candidatos"
                        className="flex flex-col items-center gap-2 text-muted"
                      >
                        <Inbox className="size-8" aria-hidden="true" />
                        <p className="text-[13px] font-semibold text-fg">
                          Nenhum candidato cadastrado ainda.
                        </p>
                        <p className="text-[12.5px] text-muted">
                          Assim que a Lia observar novos cruzamentos, eles aparecem aqui.
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  candidatos.map((c) => {
                    const desativado = c.status === "descartado";
                    return (
                      <TableRow
                        key={c.id}
                        data-row-candidato={c.id}
                        data-status={c.status}
                      >
                        <TableCell>
                          <span className="line-clamp-2 text-[12.5px] text-fg">
                            {c.descricao}
                          </span>
                          {c.motivo ? (
                            <span
                              className="mt-0.5 block text-[11.5px] text-faint"
                              title={c.motivo}
                            >
                              Motivo: {c.motivo}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Pill variant={c.origem === "humano" ? "accent" : "neutral"}>
                            {ORIGEM_LABEL[c.origem]}
                          </Pill>
                        </TableCell>
                        <TableCell className="text-[12px] text-muted">
                          {formatDateTimeFull(c.data_origem)}
                        </TableCell>
                        <TableCell className="text-[12px] text-muted">
                          {c.contexto_origem ? (
                            <span className="line-clamp-2" title={c.contexto_origem}>
                              {c.contexto_origem}
                            </span>
                          ) : (
                            <span className="text-faint">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Pill variant={pillVariantStatus(c.status)}>
                            {STATUS_LABEL[c.status]}
                          </Pill>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-1" data-actions="candidato">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={!desativado || acao.isPending}
                              onClick={() => handleAtivar(c)}
                              aria-label={`Ativar candidato ${c.id}`}
                              data-btn="ativar-candidato"
                            >
                              <CircleCheck aria-hidden="true" />
                              <span>Ativar</span>
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={desativado || acao.isPending}
                              onClick={() => abrirDesativar(c)}
                              aria-label={`Desativar candidato ${c.id}`}
                              data-btn="desativar-candidato"
                            >
                              <CircleSlash aria-hidden="true" />
                              <span>Desativar</span>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>

            {/* Keyset: carregar mais (sem truncamento silencioso) */}
            {hasNextPage ? (
              <div className="flex justify-center pt-1">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  data-btn="carregar-mais-candidatos"
                >
                  {isFetchingNextPage ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : null}
                  <span>Carregar mais</span>
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* Bloco B - editor de abreviacoes */}
      <AbreviacoesEditor />

      {/* Bloco C - ajustes tecnicos da Lia (render-only) */}
      <AjustesTecnicosCard ajustes={ajustes} isLoading={isLoading} />

      {/* Modal de desativacao (motivo obrigatorio) */}
      <Modal
        open={desativarAlvo !== null}
        onClose={() => setDesativarAlvo(null)}
        title="Desativar candidato"
        description="Explique por que este cruzamento nao deve ser permitido. O motivo fica auditado."
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDesativarAlvo(null)}
              disabled={acao.isPending}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={confirmarDesativar}
              disabled={motivo.trim() === "" || acao.isPending}
              data-btn="confirmar-desativar"
            >
              {acao.isPending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <CircleSlash aria-hidden="true" />
              )}
              <span>Desativar</span>
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          {desativarAlvo ? (
            <p className="m-0 text-[12.5px] text-muted">
              <strong className="text-fg">Candidato:</strong> {desativarAlvo.descricao}
            </p>
          ) : null}
          <label htmlFor="motivo-desativar" className="text-[12px] font-medium text-muted">
            Motivo
          </label>
          <Input
            id="motivo-desativar"
            value={motivo}
            placeholder="ex.: gera falsos positivos entre linhas distintas"
            onChange={(e) => setMotivo(e.target.value)}
            disabled={acao.isPending}
            autoFocus
          />
          {motivo.trim() === "" ? (
            <span className="text-[11px] text-faint">O motivo e obrigatorio.</span>
          ) : null}
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------
// Bloco C: ajustes tecnicos render-only.
// ---------------------------------------------------------------------

function formatAjuste(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Sim" : "Nao";
  return String(value);
}

function AjustesTecnicosCard({
  ajustes,
  isLoading,
}: {
  ajustes: AjustesTecnicosLia | null;
  isLoading: boolean;
}) {
  return (
    <section
      data-card="ajustes-tecnicos-lia"
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-fg">
            <Lock className="size-4 text-muted" aria-hidden="true" />
            Ajustes tecnicos da Lia
          </h3>
          <p className="m-0 text-[12.5px] text-muted">
            Limiares que a Lia aplica ao promover regras e montar o grafo.
          </p>
        </div>
        <Pill variant="neutral" dot data-badge="interno">
          interno
        </Pill>
      </header>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={`ajuste-skel-${i}`} className="h-10 animate-pulse rounded-sm bg-surface-3" />
          ))}
        </div>
      ) : ajustes === null ? (
        <p className="text-[12.5px] text-muted">Nenhum ajuste disponivel.</p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.keys(AJUSTE_LABEL).map((key) => (
            <div key={key} className="flex flex-col gap-0.5" data-ajuste={key}>
              <dt className="text-[11.5px] text-muted">{AJUSTE_LABEL[key]}</dt>
              <dd className="m-0 font-mono text-[13px] text-fg">
                {formatAjuste((ajustes as unknown as Record<string, unknown>)[key])}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------
// Skeleton (5 linhas x 6 colunas).
// ---------------------------------------------------------------------

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, r) => (
        <TableRow key={`cand-skel-${r}`} aria-hidden="true">
          {Array.from({ length: 6 }).map((__, c) => (
            <TableCell key={c}>
              <span
                className="block h-3 animate-pulse rounded-sm bg-surface-3"
                style={{ width: c === 0 ? "70%" : `${40 + ((r + c) % 4) * 12}%` }}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
