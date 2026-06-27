"use client";

// =====================================================================
// ActionModal — menu de acoes de um item da lista (read-only, delta-28/29).
//
// Abre ao clicar numa linha (RunsTable/DadosTable). Lista opcoes contextuais
// (Reexecutar / Conferir / Arquivar) que sao APENAS LEITURA por decisao de
// produto (Conflito 04): nenhuma persiste efeito — o clique apenas confirma a
// intencao e fecha com aviso "Apenas leitura". Fechamento por Escape, clique
// no scrim e focus-trap sao herdados do <Modal>.
//
// EC-13: quando o item ja nao existe (obsoleto/arquivado por outra aba), o
// modal exibe um aviso honesto e NAO oferece acoes — apenas fechar.
// =====================================================================

import { Info, TriangleAlert } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

/** Opcao read-only do ActionModal. */
export interface ActionOption {
  id: string;
  label: string;
  description: string;
}

export interface ActionModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  options: readonly ActionOption[];
  /** EC-13: item obsoleto — exibe aviso e suprime as acoes. */
  obsolete?: boolean;
  /** Acao escolhida (read-only): o pai apenas sinaliza e fecha. */
  onAction: (optionId: string) => void;
}

export function ActionModal({
  open,
  onClose,
  title,
  description,
  options,
  obsolete = false,
  onAction,
}: ActionModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width={460}
      footer={
        <Button variant="default" size="sm" type="button" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      {obsolete ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-warn bg-warn-bg px-3.5 py-3"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-px size-[18px] flex-none text-warn"
          />
          <div>
            <p className="text-[13.5px] font-semibold text-fg">
              Este item não está mais disponível
            </p>
            <p className="mt-0.5 text-[13px] text-muted">
              Ele foi removido ou arquivado em outra aba. Atualize a lista para
              ver o estado atual — nenhuma ação foi executada.
            </p>
          </div>
        </div>
      ) : (
        <>
          <p className="inline-flex items-center gap-1.5 text-[12px] text-soft">
            <Info aria-hidden="true" className="size-3.5" />
            Apenas leitura — as ações não alteram dados nesta versão.
          </p>
          <ul className="grid gap-1.5">
            {options.map((opt) => (
              <li key={opt.id}>
                <button
                  type="button"
                  title="Apenas leitura"
                  onClick={() => onAction(opt.id)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-md border border-border bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
                >
                  <span className="text-[13.5px] font-semibold text-fg">
                    {opt.label}
                  </span>
                  <span className="text-[12.5px] text-muted">
                    {opt.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
