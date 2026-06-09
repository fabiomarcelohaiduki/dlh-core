"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, FolderPlus, HardDrive, Loader2, Power, Trash2, TriangleAlert } from "lucide-react";
import { useRemoverDrivePasta, useSalvarDrivePasta } from "@/hooks/use-drive-pastas";
import { ConfigSectionHeading } from "@/components/cockpit/source-card";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { DrivePastaState } from "@/lib/api/types";

const addSchema = z.object({
  folderId: z.string().trim().min(1, "Cole o link ou o id da pasta do Drive."),
  nome: z.string().trim().min(1, "Dê um nome para a pasta.").max(200, "Máximo 200 caracteres."),
});
type AddValues = z.infer<typeof addSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

function mensagemErro(err: unknown): string {
  return err instanceof ApiError && (err.status === 400 || err.status === 422)
    ? "Dados inválidos: revise os campos."
    : "Não foi possível concluir. Tente novamente.";
}

/**
 * cmp-drive-pastas-form — pastas do Google Drive cadastradas para descoberta.
 *
 * Cada pasta ativa e varrida (recursivo) pelo runner no inicio do job de
 * extracao (descobrir-drive.mjs). A LISTA e hidratada server-side (RLS); as
 * escritas (adicionar/ligar-desligar/remover) passam pelo Edge drive-pastas
 * (service_role + audit). Apos salvar, router.refresh() re-hidrata a lista.
 */
export function DrivePastasForm({ initial }: { initial: DrivePastaState[] }) {
  const router = useRouter();
  const salvar = useSalvarDrivePasta();
  const remover = useRemoverDrivePasta();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<AddValues>({
    resolver: zodResolver(addSchema),
    defaultValues: { folderId: "", nome: "" },
  });

  async function onAdd(values: AddValues) {
    setFeedback(null);
    try {
      await salvar.mutateAsync({ folderId: values.folderId, nome: values.nome, ativo: true });
      reset({ folderId: "", nome: "" });
      setFeedback({ kind: "ok", message: "Pasta cadastrada · será varrida na próxima extração." });
      router.refresh();
    } catch (err) {
      setFeedback({ kind: "err", message: mensagemErro(err) });
    }
  }

  async function onToggle(pasta: DrivePastaState) {
    setFeedback(null);
    setBusyId(pasta.id);
    try {
      await salvar.mutateAsync({ folderId: pasta.folderId, nome: pasta.nome, ativo: !pasta.ativo });
      router.refresh();
    } catch (err) {
      setFeedback({ kind: "err", message: mensagemErro(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function onRemove(pasta: DrivePastaState) {
    setFeedback(null);
    setBusyId(pasta.id);
    try {
      await remover.mutateAsync(pasta.id);
      router.refresh();
    } catch (err) {
      setFeedback({ kind: "err", message: mensagemErro(err) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <ConfigSectionHeading
        title="Pastas do Drive"
        description="Pastas varridas pela extração (camada 1). Cada pasta ativa é listada recursivamente a cada execução; arquivos alterados são re-extraídos."
      />
      <div className="card form-card">
      {initial.length === 0 ? (
        <div className="banner" style={{ marginTop: 8 }}>
          <HardDrive aria-hidden="true" />
          <div>
            <b>Nenhuma pasta cadastrada</b>
            <p>Adicione uma pasta abaixo. Cole o link do Drive (.../folders/&lt;id&gt;) ou só o id.</p>
          </div>
        </div>
      ) : (
        <div className="tbl-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Id da pasta</th>
                <th>Status</th>
                <th aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {initial.map((p) => (
                <tr key={p.id}>
                  <td>{p.nome}</td>
                  <td className="mono" title={p.folderId}>
                    {p.folderId}
                  </td>
                  <td>
                    <span className={cn("pill", p.ativo ? "ok" : "idle")}>
                      <span className="dot" />
                      {p.ativo ? "Ativa" : "Pausada"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => onToggle(p)}
                        disabled={busyId === p.id}
                        title={p.ativo ? "Pausar (não varre)" : "Ativar (volta a varrer)"}
                      >
                        {busyId === p.id ? (
                          <Loader2 className="spin" aria-hidden="true" />
                        ) : (
                          <Power aria-hidden="true" />
                        )}
                        <span>{p.ativo ? "Pausar" : "Ativar"}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => onRemove(p)}
                        disabled={busyId === p.id}
                        title="Remover pasta"
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

      <form className="grid-fields" style={{ marginTop: 18 }} onSubmit={handleSubmit(onAdd)} noValidate>
        <div className={cn("field", errors.folderId && "invalid")}>
          <label htmlFor="dp-folder">Link ou id da pasta</label>
          <input
            type="text"
            id="dp-folder"
            placeholder="https://drive.google.com/drive/folders/… ou o id"
            aria-invalid={Boolean(errors.folderId)}
            {...register("folderId")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.folderId?.message ?? "Cole o link ou o id."}
          </div>
        </div>

        <div className={cn("field", errors.nome && "invalid")}>
          <label htmlFor="dp-nome">Nome</label>
          <input
            type="text"
            id="dp-nome"
            placeholder="Ex.: Editais 2026"
            aria-invalid={Boolean(errors.nome)}
            {...register("nome")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.nome?.message ?? "Dê um nome."}
          </div>
        </div>

        <div className="form-foot" style={{ gridColumn: "1 / -1", marginTop: 4 }}>
          <button className="btn btn-primary" type="submit" disabled={salvar.isPending}>
            {salvar.isPending && !busyId ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <FolderPlus aria-hidden="true" />
            )}
            <span>{salvar.isPending && !busyId ? "Adicionando…" : "Adicionar pasta"}</span>
          </button>
          {feedback && (
            <span className={cn("save-note", feedback.kind === "err" && "err")}>
              {feedback.kind === "err" ? (
                <TriangleAlert aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {feedback.message}
            </span>
          )}
        </div>
      </form>
      </div>
    </>
  );
}
