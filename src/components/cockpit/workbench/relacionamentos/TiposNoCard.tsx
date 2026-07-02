"use client";

// =====================================================================
// TiposNoCard - gestao dos tipos de no (config_tipos_no) pelo cockpit.
//
// E aqui que uma FONTE NOVA vira tipo de no sem mexer em codigo:
//   - cadastrar o tipo (identificador + label) apontando a tabela_fonte
//     do substrato; o backend valida a tabela contra o schema real e os
//     campos dela passam a alimentar os dropdowns do RegraForm.
//   - editar label / tabela_fonte e ativar/desativar tipos existentes.
//
// Consome a Edge relacionamentos-tipos-no via hooks:
//   useRelacionamentosTiposNo / useCriarRelacionamentosTipoNo /
//   useEditarRelacionamentosTipoNo.
// =====================================================================

import { useState } from "react";
import {
  CircleCheck,
  CircleSlash,
  Inbox,
  Loader2,
  Pencil,
  Plus,
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
import { ApiError } from "@/lib/api/client";
import {
  useCriarRelacionamentosTipoNo,
  useEditarRelacionamentosTipoNo,
  useRelacionamentosTiposNo,
} from "@/hooks/relacionamentos";
import type { TipoNoItem } from "@/lib/api/relacionamentos-tipos-no";
import { tipoNoLabel } from "./tipo-no-meta";

// ---------------------------------------------------------------------
// Validacao (espelha a Edge relacionamentos-tipos-no).
// ---------------------------------------------------------------------

/** Identificador do tipo: minusculo, comeca com letra (igual ao backend). */
const TIPO_REGEX = /^[a-z][a-z0-9_]{0,62}$/;

/** Nome de tabela do substrato (mesma regra do CHECK da migration). */
const TABELA_REGEX = /^[a-z][a-z0-9_]{0,62}$/;

function humanizarErro(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "Tipo nao encontrado nesta org.";
    if (err.status === 409) return "Ja existe um tipo com esse identificador.";
    if (err.status === 422)
      return "Tabela fonte inexistente ou sem coluna utilizavel no banco.";
    return err.message || "Falha na operacao. Tente novamente.";
  }
  return "Falha na operacao. Tente novamente.";
}

/** Estado do formulario do modal (criacao e edicao compartilham). */
interface TipoNoFormState {
  tipo: string;
  label: string;
  tabela_fonte: string;
}

const FORM_VAZIO: TipoNoFormState = { tipo: "", label: "", tabela_fonte: "" };

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function TiposNoCard() {
  const { toast } = useToast();
  const { data, isLoading, isError, error, refetch } =
    useRelacionamentosTiposNo();
  const criar = useCriarRelacionamentosTipoNo();
  const editar = useEditarRelacionamentosTipoNo();

  // Modal unico: null = fechado; "novo" = criacao; TipoNoItem = edicao.
  const [alvo, setAlvo] = useState<"novo" | TipoNoItem | null>(null);
  const [form, setForm] = useState<TipoNoFormState>(FORM_VAZIO);

  const tipos = data?.tipos ?? [];
  const editando = alvo !== null && alvo !== "novo";
  const salvando = criar.isPending || editar.isPending;

  // Validacao inline do form (PT-BR, antes de enviar).
  const tipoInvalido = alvo === "novo" && !TIPO_REGEX.test(form.tipo);
  const labelInvalido = form.label.trim() === "";
  const tabelaInvalida = !TABELA_REGEX.test(form.tabela_fonte);
  const formInvalido = tipoInvalido || labelInvalido || tabelaInvalida;

  function abrirNovo() {
    setAlvo("novo");
    setForm(FORM_VAZIO);
  }

  function abrirEdicao(item: TipoNoItem) {
    setAlvo(item);
    setForm({
      tipo: item.tipo,
      label: item.label,
      tabela_fonte: item.tabela_fonte ?? "",
    });
  }

  function fechar() {
    setAlvo(null);
    setForm(FORM_VAZIO);
  }

  function salvar() {
    if (alvo === null || formInvalido) return;
    const onError = (err: unknown) =>
      toast({
        title: "Nao foi possivel salvar",
        description: humanizarErro(err),
        variant: "danger",
      });
    if (alvo === "novo") {
      criar.mutate(
        {
          tipo: form.tipo.trim(),
          label: form.label.trim(),
          tabela_fonte: form.tabela_fonte.trim(),
        },
        {
          onSuccess: () => {
            toast({ title: "Tipo criado", variant: "ok" });
            fechar();
          },
          onError,
        },
      );
      return;
    }
    editar.mutate(
      {
        tipo: alvo.tipo,
        input: {
          label: form.label.trim(),
          tabela_fonte: form.tabela_fonte.trim(),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Tipo atualizado", variant: "ok" });
          fechar();
        },
        onError,
      },
    );
  }

  function alternarAtivo(item: TipoNoItem) {
    editar.mutate(
      { tipo: item.tipo, input: { ativo: !item.ativo } },
      {
        onSuccess: () =>
          toast({
            title: item.ativo ? "Tipo desativado" : "Tipo ativado",
            variant: "ok",
          }),
        onError: (err) =>
          toast({
            title: "Nao foi possivel alterar o status",
            description: humanizarErro(err),
            variant: "danger",
          }),
      },
    );
  }

  return (
    <section
      data-card="tipos-no"
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[14px] font-semibold text-fg">Tipos de no</h3>
          <p className="m-0 text-[12.5px] text-muted">
            Cada tipo aponta uma tabela do substrato; os campos dela alimentam
            os dropdowns das regras humanas. Fonte nova? Cadastre o tipo aqui.
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={abrirNovo}
          data-btn="novo-tipo-no"
        >
          <Plus aria-hidden="true" />
          <span>Novo tipo</span>
        </Button>
      </header>

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
              <TableHead className="w-[140px]">Tipo</TableHead>
              <TableHead>Label</TableHead>
              <TableHead className="w-[220px]">Tabela fonte</TableHead>
              <TableHead className="w-[90px]">Campos</TableHead>
              <TableHead className="w-[110px]">Status</TableHead>
              <TableHead className="w-[190px] text-right">Acoes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows />
            ) : tipos.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="!py-12 text-center">
                  <div
                    data-empty="tipos-no"
                    className="flex flex-col items-center gap-2 text-muted"
                  >
                    <Inbox className="size-8" aria-hidden="true" />
                    <p className="text-[13px] font-semibold text-fg">
                      Nenhum tipo cadastrado ainda.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              tipos.map((t) => (
                <TableRow key={t.tipo} data-row-tipo-no={t.tipo}>
                  <TableCell className="font-mono text-[12px] text-fg">
                    {t.tipo}
                  </TableCell>
                  <TableCell className="text-[12.5px] text-fg">
                    {t.label || tipoNoLabel(t.tipo)}
                  </TableCell>
                  <TableCell className="font-mono text-[12px] text-muted">
                    {t.tabela_fonte ?? <span className="text-faint">-</span>}
                  </TableCell>
                  <TableCell className="text-[12px] text-muted">
                    {t.campos.length}
                  </TableCell>
                  <TableCell>
                    <Pill variant={t.ativo ? "ok" : "neutral"}>
                      {t.ativo ? "Ativo" : "Inativo"}
                    </Pill>
                  </TableCell>
                  <TableCell className="text-right">
                    <div
                      className="inline-flex items-center gap-1"
                      data-actions="tipo-no"
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={salvando}
                        onClick={() => abrirEdicao(t)}
                        aria-label={`Editar tipo ${t.tipo}`}
                        data-btn="editar-tipo-no"
                      >
                        <Pencil aria-hidden="true" />
                        <span>Editar</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={salvando}
                        onClick={() => alternarAtivo(t)}
                        aria-label={
                          t.ativo
                            ? `Desativar tipo ${t.tipo}`
                            : `Ativar tipo ${t.tipo}`
                        }
                        data-btn="alternar-ativo-tipo-no"
                      >
                        {t.ativo ? (
                          <CircleSlash aria-hidden="true" />
                        ) : (
                          <CircleCheck aria-hidden="true" />
                        )}
                        <span>{t.ativo ? "Desativar" : "Ativar"}</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      {/* Modal criar/editar */}
      <Modal
        open={alvo !== null}
        onClose={fechar}
        title={editando ? "Editar tipo de no" : "Novo tipo de no"}
        description={
          editando
            ? "Ajuste o label ou aponte outra tabela do substrato."
            : "O identificador e permanente; a tabela fonte e validada contra o schema real do banco."
        }
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={fechar}
              disabled={salvando}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={salvar}
              disabled={formInvalido || salvando}
              data-btn="salvar-tipo-no"
            >
              {salvando ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <CircleCheck aria-hidden="true" />
              )}
              <span>Salvar</span>
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="tipo-no-tipo"
              className="text-[12px] font-medium text-muted"
            >
              Identificador
            </label>
            <Input
              id="tipo-no-tipo"
              value={form.tipo}
              placeholder="ex.: nota_fiscal"
              onChange={(e) => setForm({ ...form, tipo: e.target.value })}
              disabled={editando || salvando}
              autoFocus={!editando}
            />
            {alvo === "novo" && form.tipo !== "" && tipoInvalido ? (
              <span className="text-[11px] text-faint">
                Minusculo, comecando com letra (a-z, 0-9 e _).
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="tipo-no-label"
              className="text-[12px] font-medium text-muted"
            >
              Label
            </label>
            <Input
              id="tipo-no-label"
              value={form.label}
              placeholder="ex.: Nota fiscal"
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              disabled={salvando}
              autoFocus={editando}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="tipo-no-tabela"
              className="text-[12px] font-medium text-muted"
            >
              Tabela fonte
            </label>
            <Input
              id="tipo-no-tabela"
              value={form.tabela_fonte}
              placeholder="ex.: notas_fiscais"
              onChange={(e) =>
                setForm({ ...form, tabela_fonte: e.target.value })
              }
              disabled={salvando}
            />
            <span className="text-[11px] text-faint">
              Tabela do substrato cujas colunas viram os campos de regra.
            </span>
          </div>
        </div>
      </Modal>
    </section>
  );
}

// ---------------------------------------------------------------------
// Skeleton (4 linhas x 6 colunas).
// ---------------------------------------------------------------------

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, r) => (
        <TableRow key={`tipo-skel-${r}`} aria-hidden="true">
          {Array.from({ length: 6 }).map((__, c) => (
            <TableCell key={c}>
              <span
                className="block h-3 animate-pulse rounded-sm bg-surface-3"
                style={{ width: `${40 + ((r + c) % 4) * 12}%` }}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
