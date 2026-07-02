"use client";

// =====================================================================
// AbreviacoesEditor - edicao humana da abreviacao (<=8 chars) e da cor
// semantica (#RRGGBB) por tipo de no (config_tipos_no) POR ORG (F4).
//
// - Consome useRelacionamentosAbreviacoes (GET) para popular o estado inicial.
// - Valida inline (abreviacao 1..8 chars; cor hex #RRGGBB) ANTES de enviar.
// - Envia SOMENTE os tipos alterados e validos em um unico lote (PATCH).
// - Sucesso: toast verde. Erro: toast + mensagem inline (RNF-19).
// - A alteracao propaga a legenda/grafo no proximo read (nao e realtime).
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { Loader2, Palette, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { WidgetError } from "@/components/cockpit/widget-error";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api/client";
import {
  useEditarAbreviacoes,
  useRelacionamentosAbreviacoes,
} from "@/hooks/relacionamentos";
import type {
  AbreviacaoPatchItem,
  TipoAbreviacao,
} from "@/lib/api/relacionamentos-types";
import { COR_SEMANTICA_FALLBACK, tipoNoLabel } from "./tipo-no-meta";

// ---------------------------------------------------------------------
// Regras de validacao (espelham o backend F4).
// ---------------------------------------------------------------------

const ABREVIACAO_MAX = 8;
const COR_REGEX = /^#[0-9a-fA-F]{6}$/;

/** Estado editavel de uma linha do editor. */
interface RowState {
  abreviacao: string;
  cor: string;
}

/** Erros de validacao de uma linha (inline, PT-BR). */
interface RowError {
  abreviacao?: string;
  cor?: string;
}

/** Constroi o estado inicial a partir do GET (string vazia quando null). */
function toRowState(tipos: TipoAbreviacao[]): Record<string, RowState> {
  const acc: Record<string, RowState> = {};
  for (const t of tipos) {
    acc[t.tipo] = {
      abreviacao: t.abreviacao_padrao ?? "",
      cor: t.cor_semantica ?? "",
    };
  }
  return acc;
}

/** Normaliza hex para comparacao (lowercase, trim). */
function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

function humanizarErro(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "Um dos tipos nao existe mais nesta org.";
    if (err.status === 409) return "Conflito ao salvar. Recarregue e tente de novo.";
    if (err.status === 422) return "Valores invalidos: revise abreviacao e cor.";
    return err.message || "Falha ao salvar as abreviacoes.";
  }
  return "Falha ao salvar as abreviacoes.";
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function AbreviacoesEditor({ className }: { className?: string }) {
  const { toast } = useToast();
  const { data, isLoading, isError, error, refetch } = useRelacionamentosAbreviacoes();
  const editar = useEditarAbreviacoes();

  const tipos = useMemo<TipoAbreviacao[]>(() => data?.tipos ?? [], [data?.tipos]);

  const [rows, setRows] = useState<Record<string, RowState>>({});

  // Re-hidrata o estado local a cada leitura fresca (apos salvar ou refetch).
  useEffect(() => {
    setRows(toRowState(tipos));
  }, [tipos]);

  function setField(tipo: string, field: keyof RowState, value: string) {
    setRows((prev) => ({
      ...prev,
      [tipo]: { ...prev[tipo], [field]: value },
    }));
  }

  // Validacao + diff por tipo -> itens do lote e mapa de erros.
  const { itens, errors, dirtyCount } = useMemo(() => {
    const itensLote: AbreviacaoPatchItem[] = [];
    const errMap: Record<string, RowError> = {};
    let dirty = 0;

    for (const t of tipos) {
      const row = rows[t.tipo];
      if (!row) continue;

      const abrevAtual = (t.abreviacao_padrao ?? "").trim();
      const corAtual = normalizeHex(t.cor_semantica ?? "");
      const abrevNova = row.abreviacao.trim();
      const corNova = normalizeHex(row.cor);

      const abrevChanged = abrevNova !== abrevAtual;
      const corChanged = corNova !== corAtual;
      if (!abrevChanged && !corChanged) continue;
      dirty += 1;

      const rowErr: RowError = {};
      const item: AbreviacaoPatchItem = { tipo: t.tipo };

      if (abrevChanged) {
        if (abrevNova.length === 0) {
          rowErr.abreviacao = "Informe uma abreviacao (nao pode ficar vazia).";
        } else if (abrevNova.length > ABREVIACAO_MAX) {
          rowErr.abreviacao = `Maximo de ${ABREVIACAO_MAX} caracteres.`;
        } else {
          item.abreviacao_padrao = abrevNova;
        }
      }

      if (corChanged) {
        if (!COR_REGEX.test(row.cor.trim())) {
          rowErr.cor = "Use um hex no formato #RRGGBB.";
        } else {
          item.cor_semantica = row.cor.trim();
        }
      }

      if (rowErr.abreviacao || rowErr.cor) {
        errMap[t.tipo] = rowErr;
      }
      if (item.abreviacao_padrao !== undefined || item.cor_semantica !== undefined) {
        itensLote.push(item);
      }
    }

    return { itens: itensLote, errors: errMap, dirtyCount: dirty };
  }, [tipos, rows]);

  const hasErrors = Object.keys(errors).length > 0;
  const podeSalvar = itens.length > 0 && !hasErrors && !editar.isPending;

  function handleSalvar() {
    if (!podeSalvar) return;
    editar.mutate(
      { itens },
      {
        onSuccess: (res) => {
          toast({
            title: "Abreviacoes salvas",
            description:
              res.alterados.length > 0
                ? `${res.alterados.length} tipo(s) atualizado(s). A legenda usa a nova versao no proximo carregamento.`
                : "Nenhuma alteracao efetiva.",
            variant: "ok",
          });
        },
        onError: (err) => {
          toast({
            title: "Nao foi possivel salvar",
            description: humanizarErro(err),
            variant: "danger",
          });
        },
      },
    );
  }

  function handleReset() {
    setRows(toRowState(tipos));
  }

  if (isError) {
    return (
      <WidgetError
        title="Nao foi possivel carregar as abreviacoes"
        message={humanizarErro(error)}
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <section
      data-editor="abreviacoes"
      className={cn(
        "flex flex-col gap-3 rounded-md border border-border bg-surface p-4",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h4 className="flex items-center gap-1.5 text-[13.5px] font-semibold text-fg">
            <Palette className="size-4 text-muted" aria-hidden="true" />
            Abreviacoes e cores por tipo
          </h4>
          <p className="m-0 text-[12.5px] text-muted">
            Rotulo curto (ate {ABREVIACAO_MAX} caracteres) e cor semantica
            (#RRGGBB) usados na legenda e nos nos do grafo.
          </p>
        </div>
      </header>

      {isLoading ? (
        <SkeletonRows />
      ) : tipos.length === 0 ? (
        <p
          data-empty="abreviacoes"
          className="rounded-sm border border-dashed border-border px-3 py-6 text-center text-[12.5px] text-muted"
        >
          Nenhum tipo de no cadastrado ainda.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border" data-list="abreviacoes">
          {tipos.map((t) => {
            const row = rows[t.tipo] ?? { abreviacao: "", cor: "" };
            const rowErr = errors[t.tipo];
            const corSwatch = COR_REGEX.test(row.cor.trim())
              ? row.cor.trim()
              : COR_SEMANTICA_FALLBACK;
            return (
              <li
                key={t.tipo}
                data-tipo={t.tipo}
                className="flex flex-wrap items-start gap-3 py-3"
              >
                <div className="flex min-w-[120px] flex-1 flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-fg">
                    {tipoNoLabel(t.tipo)}
                  </span>
                  <span className="font-mono text-[11px] text-faint">{t.tipo}</span>
                </div>

                {/* Abreviacao */}
                <div className="flex w-[160px] flex-col gap-1">
                  <label
                    htmlFor={`abrev-${t.tipo}`}
                    className="text-[11.5px] font-medium text-muted"
                  >
                    Abreviacao
                  </label>
                  <Input
                    id={`abrev-${t.tipo}`}
                    value={row.abreviacao}
                    maxLength={ABREVIACAO_MAX}
                    state={rowErr?.abreviacao ? "error" : "default"}
                    placeholder="ex.: AVISO"
                    onChange={(e) => setField(t.tipo, "abreviacao", e.target.value)}
                    aria-invalid={rowErr?.abreviacao ? true : undefined}
                    disabled={editar.isPending}
                  />
                  {rowErr?.abreviacao ? (
                    <span className="text-[11px] text-err">{rowErr.abreviacao}</span>
                  ) : (
                    <span className="text-[11px] text-faint">
                      {row.abreviacao.trim().length}/{ABREVIACAO_MAX}
                    </span>
                  )}
                </div>

                {/* Cor semantica */}
                <div className="flex w-[190px] flex-col gap-1">
                  <label
                    htmlFor={`cor-${t.tipo}`}
                    className="text-[11.5px] font-medium text-muted"
                  >
                    Cor semantica
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={`Cor de ${tipoNoLabel(t.tipo)}`}
                      value={corSwatch}
                      onChange={(e) => setField(t.tipo, "cor", e.target.value)}
                      disabled={editar.isPending}
                      className="size-9 flex-none cursor-pointer rounded-sm border border-border bg-surface-2 p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <Input
                      id={`cor-${t.tipo}`}
                      value={row.cor}
                      placeholder="#RRGGBB"
                      state={rowErr?.cor ? "error" : "default"}
                      onChange={(e) => setField(t.tipo, "cor", e.target.value)}
                      aria-invalid={rowErr?.cor ? true : undefined}
                      disabled={editar.isPending}
                      className="font-mono"
                    />
                  </div>
                  {rowErr?.cor ? (
                    <span className="text-[11px] text-err">{rowErr.cor}</span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-[12px] text-faint" data-info="abreviacoes-dirty">
          {dirtyCount === 0
            ? "Nenhuma alteracao pendente"
            : `${dirtyCount} alteracao(oes) pendente(s)`}
          {hasErrors ? " · corrija os campos destacados" : ""}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={dirtyCount === 0 || editar.isPending}
            data-btn="reset-abreviacoes"
          >
            Descartar
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleSalvar}
            disabled={!podeSalvar}
            data-btn="salvar-abreviacoes"
          >
            {editar.isPending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Save aria-hidden="true" />
            )}
            <span>Salvar alteracoes</span>
          </Button>
        </div>
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------------
// Skeleton (5 linhas).
// ---------------------------------------------------------------------

function SkeletonRows() {
  return (
    <ul className="flex flex-col divide-y divide-border" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, r) => (
        <li key={`abrev-skel-${r}`} className="flex items-center gap-3 py-3">
          <span className="h-3 w-24 animate-pulse rounded-sm bg-surface-3" />
          <span className="h-9 w-[160px] animate-pulse rounded-sm bg-surface-3" />
          <span className="h-9 w-[190px] animate-pulse rounded-sm bg-surface-3" />
        </li>
      ))}
    </ul>
  );
}
