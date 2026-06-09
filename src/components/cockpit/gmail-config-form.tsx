"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, CalendarClock, Loader2, Power, Tag, Trash2, TriangleAlert } from "lucide-react";
import {
  useRemoverGmailLabel,
  useSalvarGmailConfig,
  useSalvarGmailLabel,
} from "@/hooks/use-gmail-config";
import { ConfigSectionHeading } from "@/components/cockpit/source-card";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { GmailConfigState, GmailLabelState } from "@/lib/api/types";

const dataSchema = z.object({
  dataInicial: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Informe uma data válida."),
});
type DataValues = z.infer<typeof dataSchema>;

const labelSchema = z.object({
  label: z.string().trim().min(1, "Informe o nome da label a excluir.").max(200, "Máximo 200 caracteres."),
});
type LabelValues = z.infer<typeof labelSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

function mensagemErro(err: unknown): string {
  return err instanceof ApiError && (err.status === 400 || err.status === 422)
    ? "Dados inválidos: revise os campos."
    : "Não foi possível concluir. Tente novamente.";
}

/**
 * cmp-gmail-config-form — config da coleta Gmail (camada 1, fonte 'gmail').
 *
 * Dois blocos: (1) DATA INICIAL — coleta so mensagens a partir dela
 * (after:YYYY/MM/DD na query); (2) LABELS DA BLACKLIST — labels a EXCLUIR
 * (decisao Fabio 2026-06-09: cadastram-se labels a NAO coletar, viram
 * -label:"nome"). A leitura e hidratada server-side (RLS); as escritas passam
 * pelo Edge gmail-config (service_role + audit). Apos salvar, router.refresh()
 * re-hidrata.
 */
export function GmailConfigForm({
  config,
  labels,
}: {
  config: GmailConfigState;
  labels: GmailLabelState[];
}) {
  const router = useRouter();
  const salvarConfig = useSalvarGmailConfig();
  const salvarLabel = useSalvarGmailLabel();
  const removerLabel = useRemoverGmailLabel();
  const [dataFeedback, setDataFeedback] = useState<Feedback | null>(null);
  const [labelFeedback, setLabelFeedback] = useState<Feedback | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const dataForm = useForm<DataValues>({
    resolver: zodResolver(dataSchema),
    defaultValues: { dataInicial: config.dataInicial ?? "" },
  });

  const labelForm = useForm<LabelValues>({
    resolver: zodResolver(labelSchema),
    defaultValues: { label: "" },
  });

  async function onSalvarData(values: DataValues) {
    setDataFeedback(null);
    try {
      await salvarConfig.mutateAsync(values.dataInicial);
      setDataFeedback({ kind: "ok", message: "Data inicial salva · vale na próxima coleta." });
      router.refresh();
    } catch (err) {
      setDataFeedback({ kind: "err", message: mensagemErro(err) });
    }
  }

  async function onAddLabel(values: LabelValues) {
    setLabelFeedback(null);
    try {
      await salvarLabel.mutateAsync({ label: values.label, ativo: true });
      labelForm.reset({ label: "" });
      setLabelFeedback({ kind: "ok", message: "Label adicionada · será excluída da coleta." });
      router.refresh();
    } catch (err) {
      setLabelFeedback({ kind: "err", message: mensagemErro(err) });
    }
  }

  async function onToggleLabel(l: GmailLabelState) {
    setLabelFeedback(null);
    setBusyId(l.id);
    try {
      await salvarLabel.mutateAsync({ label: l.label, ativo: !l.ativo });
      router.refresh();
    } catch (err) {
      setLabelFeedback({ kind: "err", message: mensagemErro(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function onRemoveLabel(l: GmailLabelState) {
    setLabelFeedback(null);
    setBusyId(l.id);
    try {
      await removerLabel.mutateAsync(l.id);
      router.refresh();
    } catch (err) {
      setLabelFeedback({ kind: "err", message: mensagemErro(err) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <ConfigSectionHeading
        title="Configuração da coleta"
        description="Coleta cada e-mail a partir da data inicial: o corpo e cada anexo viram documentos da camada 1. As labels abaixo são uma blacklist — e-mails com essas labels são excluídos da coleta."
      />
      <div className="card form-card">
      <form
        className="grid-fields"
        style={{ marginTop: 4 }}
        onSubmit={dataForm.handleSubmit(onSalvarData)}
        noValidate
      >
        <div className={cn("field", dataForm.formState.errors.dataInicial && "invalid")}>
          <label htmlFor="gm-data">Coletar e-mails a partir de</label>
          <input
            type="date"
            id="gm-data"
            aria-invalid={Boolean(dataForm.formState.errors.dataInicial)}
            {...dataForm.register("dataInicial")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {dataForm.formState.errors.dataInicial?.message ?? "Informe uma data válida."}
          </div>
        </div>

        <div className="form-foot" style={{ gridColumn: "1 / -1", marginTop: 4 }}>
          <button className="btn btn-primary" type="submit" disabled={salvarConfig.isPending}>
            {salvarConfig.isPending ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <CalendarClock aria-hidden="true" />
            )}
            <span>{salvarConfig.isPending ? "Salvando…" : "Salvar data inicial"}</span>
          </button>
          {dataFeedback && (
            <span className={cn("save-note", dataFeedback.kind === "err" && "err")}>
              {dataFeedback.kind === "err" ? (
                <TriangleAlert aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {dataFeedback.message}
            </span>
          )}
        </div>
      </form>

      <div className="section-title" style={{ margin: "24px 0 13px" }}>
        <h3>Labels excluídas da coleta</h3>
      </div>

      {labels.length === 0 ? (
        <div className="banner" style={{ marginTop: 8 }}>
          <Tag aria-hidden="true" />
          <div>
            <b>Nenhuma label excluída</b>
            <p>Sem labels na blacklist, todos os e-mails a partir da data inicial são coletados.</p>
          </div>
        </div>
      ) : (
        <div className="tbl-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Status</th>
                <th aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {labels.map((l) => (
                <tr key={l.id}>
                  <td className="mono" title={l.label}>
                    {l.nome}
                  </td>
                  <td>
                    <span className={cn("pill", l.ativo ? "ok" : "idle")}>
                      <span className="dot" />
                      {l.ativo ? "Excluindo" : "Pausada"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => onToggleLabel(l)}
                        disabled={busyId === l.id}
                        title={l.ativo ? "Pausar (volta a coletar)" : "Ativar (volta a excluir)"}
                      >
                        {busyId === l.id ? (
                          <Loader2 className="spin" aria-hidden="true" />
                        ) : (
                          <Power aria-hidden="true" />
                        )}
                        <span>{l.ativo ? "Pausar" : "Ativar"}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => onRemoveLabel(l)}
                        disabled={busyId === l.id}
                        title="Remover label"
                      >
                        <Trash2 aria-hidden="true" />
                        <span>Remover</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="grid-fields"
        style={{ marginTop: 18 }}
        onSubmit={labelForm.handleSubmit(onAddLabel)}
        noValidate
      >
        <div className={cn("field", labelForm.formState.errors.label && "invalid")}>
          <label htmlFor="gm-label">Nome da label no Gmail</label>
          <input
            type="text"
            id="gm-label"
            placeholder="Ex.: Promoções, Social, CATEGORY_PROMOTIONS"
            aria-invalid={Boolean(labelForm.formState.errors.label)}
            {...labelForm.register("label")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {labelForm.formState.errors.label?.message ?? "Informe o nome da label."}
          </div>
        </div>

        <div className="form-foot" style={{ gridColumn: "1 / -1", marginTop: 4 }}>
          <button className="btn btn-primary" type="submit" disabled={salvarLabel.isPending}>
            {salvarLabel.isPending && !busyId ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <Tag aria-hidden="true" />
            )}
            <span>{salvarLabel.isPending && !busyId ? "Adicionando…" : "Excluir label"}</span>
          </button>
          {labelFeedback && (
            <span className={cn("save-note", labelFeedback.kind === "err" && "err")}>
              {labelFeedback.kind === "err" ? (
                <TriangleAlert aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {labelFeedback.message}
            </span>
          )}
        </div>
      </form>
      </div>
    </>
  );
}
