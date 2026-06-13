"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, Pencil, Plus, TriangleAlert, Trash2, X } from "lucide-react";
import {
  useCreateDiretriz,
  useDeleteDiretriz,
  useDiretrizes,
  useUpdateDiretriz,
} from "@/hooks/use-criterios";
import {
  useCreatePolitica,
  usePolitica,
  useUpdatePolitica,
} from "@/hooks/use-politica";
import { cn } from "@/lib/utils";
import type { CotacaoNivel, PoliticaParticipa } from "@/lib/api/types";

const PARTICIPA: { value: PoliticaParticipa; label: string }[] = [
  { value: "sim", label: "Sim" },
  { value: "nao", label: "Não" },
  { value: "condicional", label: "Condicional" },
];

/**
 * cmp-criterios-panel — Bloco 4: diretrizes textuais, regras estruturadas e
 * politica de participacao de cotacao para um escopo (LINHA ou PRODUTO). O
 * mesmo painel atende os dois niveis variando `nivel`/`escopoId`. Diretrizes e
 * politica.diretriz_texto sao reindexadas semanticamente no backend ao salvar.
 */
export function CriteriosPanel({
  nivel,
  escopoId,
}: {
  nivel: CotacaoNivel;
  escopoId: string;
}) {
  const params = { nivel, escopo_id: escopoId };

  return (
    <div className="grid-dlh g2" style={{ alignItems: "start" }}>
      <DiretrizesBlock params={params} nivel={nivel} escopoId={escopoId} />
      <PoliticaBlock params={params} nivel={nivel} escopoId={escopoId} />
    </div>
  );
}

type ListParams = { nivel: CotacaoNivel; escopo_id: string };

// --- Diretrizes -----------------------------------------------------

function DiretrizesBlock({
  params,
  nivel,
  escopoId,
}: {
  params: ListParams;
  nivel: CotacaoNivel;
  escopoId: string;
}) {
  const diretrizes = useDiretrizes(params);
  const createDiretriz = useCreateDiretriz();
  const updateDiretriz = useUpdateDiretriz();
  const deleteDiretriz = useDeleteDiretriz();

  const [texto, setTexto] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const items = diretrizes.data?.items ?? [];

  async function onAdd() {
    const t = texto.trim();
    if (!t) {
      setErro("Escreva a diretriz antes de salvar.");
      return;
    }
    setErro(null);
    try {
      await createDiretriz.mutateAsync({ nivel, escopo_id: escopoId, texto: t });
      setTexto("");
    } catch {
      setErro("Não foi possível salvar a diretriz. Tente novamente.");
    }
  }

  function startEdit(id: string, current: string) {
    setEditingId(id);
    setEditingText(current);
    setErro(null);
  }

  async function onSaveEdit(id: string) {
    const t = editingText.trim();
    if (!t) {
      setErro("A diretriz não pode ficar vazia.");
      return;
    }
    setErro(null);
    try {
      await updateDiretriz.mutateAsync({ id, input: { texto: t } });
      setEditingId(null);
      setEditingText("");
    } catch {
      setErro("Não foi possível salvar a diretriz. Tente novamente.");
    }
  }

  async function onRemove(id: string) {
    setRemovingId(id);
    try {
      await deleteDiretriz.mutateAsync(id);
      if (editingId === id) setEditingId(null);
    } catch {
      setErro("Não foi possível remover a diretriz.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 8px" }}>
        <h3>Diretrizes de cotação</h3>
        <span className="count">{items.length}</span>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: "12px", lineHeight: 1.5, color: "var(--faint)" }}>
        Orientações em texto livre que a Lia lê ao montar uma cotação. Não são
        travas rígidas, são instruções gerais (ex.: priorizar acabamento fosco em
        licitações públicas). Ficam indexadas semanticamente para a IA consultar.
      </p>
      {diretrizes.isLoading ? (
        <span className="skel skel-line" style={{ width: "70%" }} />
      ) : items.length === 0 ? (
        <p style={{ margin: "0 0 14px", fontSize: "12.5px", color: "var(--muted)" }}>
          Nenhuma diretriz textual neste escopo. Adicione orientações livres para
          a cotação.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 10, marginBottom: 14 }}>
          {items.map((d) =>
            editingId === d.id ? (
              <div
                key={d.id}
                className="card"
                style={{ display: "grid", gap: 10, padding: "12px 14px" }}
              >
                <textarea
                  rows={3}
                  value={editingText}
                  onChange={(e) => {
                    setEditingText(e.target.value);
                    setErro(null);
                  }}
                  aria-label="Editar diretriz"
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => onSaveEdit(d.id)}
                    disabled={updateDiretriz.isPending}
                  >
                    {updateDiretriz.isPending ? (
                      <Loader2 className="spin" aria-hidden="true" />
                    ) : (
                      <Check aria-hidden="true" />
                    )}
                    <span>Salvar</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setEditingId(null);
                      setEditingText("");
                      setErro(null);
                    }}
                    disabled={updateDiretriz.isPending}
                  >
                    <X aria-hidden="true" />
                    <span>Cancelar</span>
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={d.id}
                className="card"
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  padding: "12px 14px",
                }}
              >
                <p
                  style={{
                    margin: 0,
                    flex: 1,
                    fontSize: "12.5px",
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {d.texto}
                </p>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => startEdit(d.id, d.texto)}
                  aria-label="Editar diretriz"
                >
                  <Pencil aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onRemove(d.id)}
                  disabled={removingId === d.id}
                  aria-label="Remover diretriz"
                >
                  {removingId === d.id ? (
                    <Loader2 className="spin" aria-hidden="true" />
                  ) : (
                    <Trash2 aria-hidden="true" />
                  )}
                </button>
              </div>
            ),
          )}
        </div>
      )}

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`diretriz-${escopoId}`}>Nova diretriz</label>
        <textarea
          id={`diretriz-${escopoId}`}
          rows={3}
          placeholder="ex.: Priorizar acabamento fosco em cotações públicas."
          value={texto}
          onChange={(e) => {
            setTexto(e.target.value);
            setErro(null);
          }}
        />
      </div>
      <div className="form-foot" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onAdd}
          disabled={createDiretriz.isPending}
        >
          {createDiretriz.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Plus aria-hidden="true" />
          )}
          <span>Adicionar diretriz</span>
        </button>
        {erro && (
          <span className="save-note err">
            <TriangleAlert aria-hidden="true" />
            {erro}
          </span>
        )}
      </div>
    </div>
  );
}

// --- Politica de participacao --------------------------------------

const politicaSchema = z
  .object({
    participa: z.enum(["sim", "nao", "condicional"]),
    condicao: z.string().trim().optional(),
    diretriz_texto: z.string().trim().optional(),
    // Preferencia so e capturada no nivel Produto (opcional).
    preferencia: z.string().trim().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.participa === "condicional" && !val.condicao) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["condicao"],
        message: "Descreva a condição da participação.",
      });
    }
  });
type PoliticaValues = z.infer<typeof politicaSchema>;

function PoliticaBlock({
  params,
  nivel,
  escopoId,
}: {
  params: ListParams;
  nivel: CotacaoNivel;
  escopoId: string;
}) {
  const politica = usePolitica(params);
  const createPolitica = useCreatePolitica();
  const updatePolitica = useUpdatePolitica();

  const existing = politica.data?.items?.[0] ?? null;
  // preferencia opcional SO no nivel Produto (RF da sprint).
  const allowPreferencia = nivel === "produto";

  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<PoliticaValues>({
    resolver: zodResolver(politicaSchema),
    defaultValues: {
      participa: "sim",
      condicao: "",
      diretriz_texto: "",
      preferencia: "",
    },
  });

  const participa = watch("participa");

  // Hidrata o form quando a politica existente carrega/muda de escopo.
  useEffect(() => {
    reset({
      participa: existing?.participa ?? "sim",
      condicao: existing?.condicao ?? "",
      diretriz_texto: existing?.diretriz_texto ?? "",
      preferencia: existing?.preferencia ?? "",
    });
    setFeedback(null);
  }, [existing, reset]);

  const pending = createPolitica.isPending || updatePolitica.isPending;

  async function onSubmit(values: PoliticaValues) {
    setFeedback(null);
    const input = {
      nivel,
      escopo_id: escopoId,
      participa: values.participa as PoliticaParticipa,
      condicao:
        values.participa === "condicional" && values.condicao?.trim()
          ? values.condicao.trim()
          : null,
      diretriz_texto: values.diretriz_texto?.trim()
        ? values.diretriz_texto.trim()
        : null,
      preferencia:
        allowPreferencia && values.preferencia?.trim()
          ? values.preferencia.trim()
          : null,
    };
    try {
      if (existing) {
        await updatePolitica.mutateAsync({ id: existing.id, input });
      } else {
        await createPolitica.mutateAsync(input);
      }
      setFeedback({ kind: "ok", msg: "Política salva." });
    } catch {
      setFeedback({ kind: "err", msg: "Não foi possível salvar a política." });
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="section-title" style={{ margin: "0 0 8px" }}>
        <h3>Política de participação</h3>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: "12px", lineHeight: 1.5, color: "var(--faint)" }}>
        Define se a DLH participa de licitação neste escopo (Sim / Não /
        Condicional) e sob qual condição. A diretriz textual orienta a decisão da
        Lia quando o caso não é um sim ou não direto.
      </p>

      {politica.isLoading ? (
        <span className="skel skel-line" style={{ width: "70%" }} />
      ) : (
        <>
          <div className="field">
            <label htmlFor={`pol-participa-${escopoId}`}>Participa de licitação?</label>
            <select id={`pol-participa-${escopoId}`} {...register("participa")}>
              {PARTICIPA.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {participa === "condicional" && (
            <div className={cn("field", errors.condicao && "invalid")}>
              <label htmlFor={`pol-condicao-${escopoId}`}>Condição</label>
              <input
                id={`pol-condicao-${escopoId}`}
                type="text"
                placeholder="ex.: somente acima de 100 unidades"
                aria-invalid={Boolean(errors.condicao)}
                {...register("condicao")}
              />
              <div className="err-msg">
                <TriangleAlert aria-hidden="true" />
                {errors.condicao?.message ?? "Descreva a condição da participação."}
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor={`pol-diretriz-${escopoId}`}>Diretriz</label>
            <textarea
              id={`pol-diretriz-${escopoId}`}
              rows={2}
              placeholder="Orientação textual da política (indexada para a Lia)."
              {...register("diretriz_texto")}
            />
          </div>

          {allowPreferencia && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor={`pol-pref-${escopoId}`}>Preferência</label>
              <input
                id={`pol-pref-${escopoId}`}
                type="text"
                placeholder="Opcional"
                {...register("preferencia")}
              />
            </div>
          )}

          <div className="form-foot" style={{ marginTop: 14 }}>
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              <span>{pending ? "Salvando…" : "Salvar política"}</span>
            </button>
            {feedback && (
              <span className={cn("save-note", feedback.kind === "err" && "err")}>
                {feedback.kind === "err" ? (
                  <TriangleAlert aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                {feedback.msg}
              </span>
            )}
          </div>
        </>
      )}
    </form>
  );
}
