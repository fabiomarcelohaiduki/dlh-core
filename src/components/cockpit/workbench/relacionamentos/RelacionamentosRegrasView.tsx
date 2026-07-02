"use client";

// =====================================================================
// RelacionamentosRegrasView - sub-secao B do painel de Relacionamentos:
// lista/cria/edita/exclui regras humanas do catalogo
// (catalogo_regras_vinculo).
//
// Estrutura:
//   1) Card de resumo explicativo (como funcionam as regras + alerta do
//      gate anti numero_pregao);
//   2) Toolbar com filtro (apenas ativos?) e acao "Nova regra" que abre
//      o RegraForm num modal;
//   3) Tabela densa com colunas: origem tipo/campo, destino tipo/campo,
//      combinacao, sequencia (preview), ativa (badge com toggle) e
//      updated_at (relativo);
//   4) Skeleton de 5 linhas enquanto carrega + empty-state honesto;
//   5) Botoes por linha: Editar (modal), Ativar/Desativar (toggle inline
//      com confirmacao), Excluir (confirmacao via Modal);
//   6) Toasts verde "Regra salva" / erro PT-BR usando useToast;
//   7) Bloco de reordenacao (RegraReordenar) abaixo da tabela.
//
// Gestao de mutacoes usa os hooks de use-relacionamentos-regras (criacao,
// edicao, toggle, excluir) que ja cuidam da invalidacao das chaves de
// cache. A propria view e controlada, sem router refresh.
// =====================================================================

import { useMemo, useState } from "react";
import {
  Inbox,
  Pencil,
  Plus,
  Power,
  RefreshCcw,
  Trash2,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Toggle } from "@/components/ui/toggle";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { formatDateTimeFull } from "@/lib/format";
import { ApiError } from "@/lib/api/client";
import {
  useAtivarRelacionamentosRegra,
  useExcluirRelacionamentosRegra,
  useRelacionamentosRegras,
} from "@/hooks/relacionamentos/use-relacionamentos-regras";
import type { Regra } from "@/lib/api/relacionamentos-types";
import { WidgetError } from "@/components/cockpit/widget-error";
import { RegraForm } from "./RegraForm";
import { RegraReordenar } from "./RegraReordenar";

// ---------------------------------------------------------------------
// Tipos locais.
// ---------------------------------------------------------------------

type FiltroAtiva = "todas" | "ativas" | "inativas";

type Editing =
  | { mode: "create" }
  | { mode: "edit"; regra: Regra }
  | null;

// ---------------------------------------------------------------------
// Skeleton de carregamento da tabela (5 linhas x 7 colunas).
// ---------------------------------------------------------------------

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, r) => (
        <TableRow key={`skel-${r}`} aria-hidden="true">
          {Array.from({ length: 7 }).map((__, c) => (
            <TableCell key={c}>
              <span
                className="block h-3 animate-pulse rounded-sm bg-surface-3"
                style={{ width: c === 6 ? 100 : `${50 + ((r + c) % 4) * 12}%` }}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------
// Mapeamentos visuais.
// ---------------------------------------------------------------------

const COMBINACAO_LABEL: Record<Regra["combinacao"], string> = {
  simples: "Simples",
  composta: "Composta",
};

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function RelacionamentosRegrasView() {
  const [filtroAtiva, setFiltroAtiva] = useState<FiltroAtiva>("todas");
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmDelete, setConfirmDelete] = useState<Regra | null>(null);

  const ativoFilter =
    filtroAtiva === "todas" ? undefined : filtroAtiva === "ativas";

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
  } = useRelacionamentosRegras({
    ativa: ativoFilter,
  });

  const ativar = useAtivarRelacionamentosRegra();
  const excluir = useExcluirRelacionamentosRegra();
  const { toast } = useToast();

  const items = useMemo(() => data?.items ?? [], [data]);

  async function handleToggle(regra: Regra) {
    try {
      await ativar.mutateAsync({ id: regra.id, ativa: !regra.ativa });
      toast({
        title: regra.ativa ? "Regra desativada" : "Regra ativada",
        variant: "ok",
      });
    } catch (err) {
      toast({
        title: "Erro ao alterar regra",
        description: humanizarErro(err),
        variant: "danger",
      });
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    try {
      await excluir.mutateAsync(id);
      toast({ title: "Regra removida", variant: "ok" });
      setConfirmDelete(null);
    } catch (err) {
      toast({
        title: "Erro ao remover regra",
        description: humanizarErro(err),
        variant: "danger",
      });
    }
  }

  function handleSaved() {
    setEditing(null);
  }

  return (
    <>
      {/* Card de resumo */}
      <section
        data-card="info-regras"
        className="flex flex-col gap-2 rounded-md border border-border bg-surface-2/40 p-4"
      >
        <p className="m-0 text-[13px] text-muted">
          <strong className="text-fg">Como funcionam.</strong> As regras humanas
          sao match deterministicos entre campos de 2 nos. Quando o backfill roda,
          cada aresta estrutural e enriquecida com o nome da regra que a produziu.
          Regras <strong>compostas</strong> sao mais precisas (AND logico) e tem
          prioridade.
        </p>
        <p className="m-0 text-[12.5px] text-warn">
          <strong>Hard block ativo:</strong> regras simples com campo destino no
          numero do pregao sozinho
          <code className="mx-1 rounded-sm bg-surface-3 px-1 py-px font-mono text-[11px]">
            payload_bruto.processo
          </code>
          sao bloqueadas - esse cenario gera falsos positivos. Use regra composta
          com
          <code className="mx-1 rounded-sm bg-surface-3 px-1 py-px font-mono text-[11px]">
            payload_bruto.uasg
          </code>
          .
        </p>
      </section>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label
            htmlFor="filtro-ativa"
            className="text-[12.5px] font-medium text-muted"
          >
            Status
          </label>
          <Select
            id="filtro-ativa"
            value={filtroAtiva}
            onChange={(e) => setFiltroAtiva(e.target.value as FiltroAtiva)}
            className="min-w-[160px]"
          >
            <option value="todas">Todas</option>
            <option value="ativas">Apenas ativas</option>
            <option value="inativas">Apenas inativas</option>
          </Select>
          {!isLoading ? (
            <span className="text-[12px] text-faint">
              {items.length} {items.length === 1 ? "regra" : "regras"}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="default"
            onClick={() => refetch()}
            aria-label="Recarregar lista de regras"
            disabled={isLoading}
          >
            <RefreshCcw aria-hidden="true" />
            <span>Recarregar</span>
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => setEditing({ mode: "create" })}
            disabled={Boolean(editing)}
            data-btn="nova-regra"
          >
            <Plus aria-hidden="true" />
            <span>Nova regra</span>
          </Button>
        </div>
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
              <TableHead>Origem</TableHead>
              <TableHead>Campo origem</TableHead>
              <TableHead>Destino</TableHead>
              <TableHead>Campo destino</TableHead>
              <TableHead>Combinação</TableHead>
              <TableHead>Sequência</TableHead>
              <TableHead className="w-[110px]">Ativa</TableHead>
              <TableHead className="w-[150px]">Atualizada</TableHead>
              <TableHead className="w-[180px] text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows />
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="!py-12 text-center">
                  <div
                    data-empty="regras"
                    className="flex flex-col items-center gap-2 text-muted"
                  >
                    <Inbox className="size-8" aria-hidden="true" />
                    <p className="text-[13px] font-semibold text-fg">
                      Nenhuma regra {filtroAtiva === "ativas" ? "ativa" : filtroAtiva === "inativas" ? "inativa" : ""} cadastrada
                    </p>
                    <p className="text-[12.5px] text-muted">
                      Crie a primeira regra para iniciar o match deterministico no backfill.
                    </p>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => setEditing({ mode: "create" })}
                    >
                      <Plus aria-hidden="true" />
                      <span>Nova regra</span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((regra) => (
                <TableRow
                  key={regra.id}
                  data-row-regra={regra.id}
                  data-ativa={regra.ativa ? "true" : "false"}
                >
                  <TableCell>
                    <Pill variant="neutral">{regra.origem_tipo}</Pill>
                  </TableCell>
                  <TableCell className="font-mono text-[12px] text-muted">
                    {regra.campo_origem}
                  </TableCell>
                  <TableCell>
                    <Pill variant="neutral">{regra.destino_tipo}</Pill>
                  </TableCell>
                  <TableCell className="font-mono text-[12px] text-muted">
                    {regra.campo_destino}
                  </TableCell>
                  <TableCell>
                    <Pill
                      variant={regra.combinacao === "composta" ? "accent" : "neutral"}
                    >
                      {COMBINACAO_LABEL[regra.combinacao]}
                    </Pill>
                  </TableCell>
                  <TableCell>
                    {Array.isArray(regra.sequencia) && regra.sequencia.length > 0 ? (
                      <span className="font-mono text-[11.5px] text-muted">
                        {regra.sequencia.join(" → ")}
                      </span>
                    ) : (
                      <span className="text-[11.5px] text-faint">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Toggle
                      checked={regra.ativa}
                      onChange={() => handleToggle(regra)}
                      ariaLabel={`${regra.ativa ? "Desativar" : "Ativar"} regra ${regra.nome ?? regra.campo_destino}`}
                      disabled={ativar.isPending && ativar.variables?.id === regra.id}
                    />
                  </TableCell>
                  <TableCell className="text-[12px] text-muted">
                    {formatDateTimeFull(regra.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing({ mode: "edit", regra })}
                        aria-label={`Editar regra ${regra.nome ?? regra.campo_destino}`}
                        data-btn="editar-regra"
                      >
                        <Pencil aria-hidden="true" />
                        <span>Editar</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleToggle(regra)}
                        aria-label={`${regra.ativa ? "Desativar" : "Ativar"} regra ${regra.nome ?? regra.campo_destino}`}
                        data-btn="ativar-regra"
                      >
                        <Power aria-hidden="true" />
                        <span>{regra.ativa ? "Desativar" : "Ativar"}</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDelete(regra)}
                        aria-label={`Excluir regra ${regra.nome ?? regra.campo_destino}`}
                        data-btn="excluir-regra"
                      >
                        <Trash2 aria-hidden="true" />
                        <span>Excluir</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      {/* Bloco de reordenacao minima (abaixo da tabela) */}
      {!isLoading && items.length > 1 ? (
        <RegraReordenar regras={items} />
      ) : null}

      {/* Modal de criacao / edicao */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.mode === "edit" ? "Editar regra humana" : "Nova regra humana"}
        description={
          editing?.mode === "edit"
            ? "Atualize os campos da regra. As alteracoes valem na proxima rodada de backfill."
            : "Defina um match deterministico entre 2 nos. Regras compostas sao preferidas."
        }
        width={640}
      >
        {editing ? (
          <RegraForm
            key={editing.mode === "edit" ? editing.regra.id : "novo"}
            regra={editing.mode === "edit" ? editing.regra : undefined}
            onSuccess={handleSaved}
            onCancel={() => setEditing(null)}
          />
        ) : null}
      </Modal>

      {/* Modal de confirmacao de exclusao */}
      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title="Excluir regra humana"
        description={
          confirmDelete
            ? `Esta acao remove a regra "${confirmDelete.nome ?? `${confirmDelete.origem_tipo}.${confirmDelete.campo_origem} -> ${confirmDelete.destino_tipo}.${confirmDelete.campo_destino}`}" do catalogo. Arestas ja criadas NAO sao apagadas - apenas deixam de ser regeneradas em novos backfills.`
            : ""
        }
        width={480}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmDelete(null)}
              disabled={excluir.isPending}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleConfirmDelete}
              disabled={excluir.isPending}
              data-btn="confirmar-excluir-regra"
              className={cn(
                "!bg-err hover:!bg-err/90",
              )}
            >
              <Trash2 aria-hidden="true" />
              <span>
                {excluir.isPending ? "Removendo…" : "Sim, excluir regra"}
              </span>
            </Button>
          </>
        }
      >
        {confirmDelete ? (
          <ul className="flex flex-col gap-1 rounded-md border border-border bg-surface-2/40 p-3 text-[12.5px] text-muted">
            <li>
              <strong className="text-fg">Origem:</strong>{" "}
              {confirmDelete.origem_tipo}.{confirmDelete.campo_origem}
            </li>
            <li>
              <strong className="text-fg">Destino:</strong>{" "}
              {confirmDelete.destino_tipo}.{confirmDelete.campo_destino}
            </li>
            <li>
              <strong className="text-fg">Combinação:</strong>{" "}
              {COMBINACAO_LABEL[confirmDelete.combinacao]}
            </li>
          </ul>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

function humanizarErro(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "Esta regra não existe mais.";
    if (err.status === 409)
      return "Não foi possível remover: há vínculos pendentes associados a esta regra.";
    if (err.status === 422)
      return "Operação inválida: confira a combinação e o campo de destino.";
    return err.message || "Falha na operação. Tente novamente.";
  }
  return "Falha na operação. Tente novamente.";
}
