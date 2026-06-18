"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, ChevronRight, Loader2, Plus, TriangleAlert, Trash2, X } from "lucide-react";
import {
  useCreateDiretriz,
  useCreateRegra,
  useDeleteDiretriz,
  useDeleteRegra,
  useDiretrizes,
  useRegras,
  useUpdateDiretriz,
  useUpdateRegra,
} from "@/hooks/use-criterios";
import {
  useCreatePolitica,
  usePolitica,
  useUpdatePolitica,
} from "@/hooks/use-politica";
import { cn } from "@/lib/utils";
import type {
  CotacaoNivel,
  CotacaoRegra,
  CotacaoTipoRegra,
  PoliticaParticipa,
} from "@/lib/api/types";

const PARTICIPA: { value: PoliticaParticipa; label: string }[] = [
  { value: "sim", label: "Sim" },
  { value: "nao", label: "Não" },
  { value: "condicional", label: "Condicional" },
];

const TIPO_REGRA: { value: CotacaoTipoRegra; label: string; ajuda: string }[] = [
  {
    value: "faixa",
    label: "Faixa de valor",
    ajuda: "Tolera variação numérica de um atributo (ex.: dimensão 28 a 32 cm).",
  },
  {
    value: "opcional",
    label: "Atributo opcional",
    ajuda: "O atributo pode faltar no edital sem desqualificar a cotação.",
  },
  {
    value: "substituicao",
    label: "Substituição equivalente",
    ajuda: "Permite trocar por um equivalente (ex.: composição diferente aceita).",
  },
];

/**
 * cmp-criterios-panel — Bloco 4: diretrizes textuais, regras estruturadas e
 * politica de participacao de cotacao para um escopo (LINHA, PRODUTO ou SKU). O
 * mesmo painel atende os tres niveis variando `nivel`/`escopoId`. Diretrizes
 * alimentam a busca semantica (embedding); politica e regras sao carimbos
 * deterministicos que a Lia segue (nunca entram no embedding).
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
    <div style={{ display: "grid", gap: 16 }}>
      <div className="grid-dlh g2" style={{ alignItems: "start" }}>
        <DiretrizesBlock params={params} nivel={nivel} escopoId={escopoId} />
        <PoliticaBlock params={params} nivel={nivel} escopoId={escopoId} />
      </div>
      <RegrasBlock params={params} nivel={nivel} escopoId={escopoId} />
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
  const [creating, setCreating] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const items = diretrizes.data?.items ?? [];

  async function onAdd() {
    const t = texto.trim();
    if (!t) {
      setErro("Escreva o termo antes de salvar.");
      return;
    }
    setErro(null);
    try {
      await createDiretriz.mutateAsync({ nivel, escopo_id: escopoId, texto: t });
      setTexto("");
      setCreating(false);
    } catch {
      setErro("Não foi possível salvar o termo. Tente novamente.");
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
      setErro("O termo não pode ficar vazio.");
      return;
    }
    setErro(null);
    try {
      await updateDiretriz.mutateAsync({ id, input: { texto: t } });
      setEditingId(null);
      setEditingText("");
    } catch {
      setErro("Não foi possível salvar o termo. Tente novamente.");
    }
  }

  async function onRemove(id: string) {
    setRemovingId(id);
    try {
      await deleteDiretriz.mutateAsync(id);
      if (editingId === id) setEditingId(null);
    } catch {
      setErro("Não foi possível remover o termo.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 8px" }}>
        <h3>Termos de busca</h3>
        <span className="count">{items.length}</span>
        {!creating ? (
          <button
            type="button"
            className="btn btn-sm btn-icon"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              setCreating(true);
              setErro(null);
            }}
            aria-label="Novo termo"
            title="Novo termo"
          >
            <Plus aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p className="helper" style={{ margin: "0 0 14px" }}>
        Vocabulário que ajuda a Lia a <strong>encontrar</strong> este item no
        edital: sinônimos, aplicações, termos técnicos e materiais. Entra na
        busca semântica. Não escreva decisão, preço, margem nem tolerância aqui
        (isso vai em Política e Regras).
      </p>
      {diretrizes.isLoading ? (
        <span className="skel skel-line" style={{ width: "70%" }} />
      ) : items.length === 0 ? null : (
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
                  aria-label="Editar termo"
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
                  className="btn btn-sm btn-icon"
                  style={{ color: "var(--accent)" }}
                  onClick={() => startEdit(d.id, d.texto)}
                  aria-label="Editar termo"
                  title="Editar"
                >
                  <ChevronRight aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-icon"
                  onClick={() => onRemove(d.id)}
                  disabled={removingId === d.id}
                  aria-label="Remover termo"
                  title="Excluir"
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

      {creating && (
        <>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`diretriz-${escopoId}`}>Novo termo</label>
            <textarea
              id={`diretriz-${escopoId}`}
              rows={3}
              placeholder="ex.: Também chamado de apoio de punho. Usado em estações de digitação. Superfície em gel de silicone."
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
              <span>Adicionar termo</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCreating(false);
                setTexto("");
                setErro(null);
              }}
              disabled={createDiretriz.isPending}
            >
              <X aria-hidden="true" />
              <span>Cancelar</span>
            </button>
            {erro && (
              <span className="save-note err">
                <TriangleAlert aria-hidden="true" />
                {erro}
              </span>
            )}
          </div>
        </>
      )}
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
      <p className="helper" style={{ margin: "0 0 14px" }}>
        Decisão de entrar ou não na licitação deste escopo (Sim / Não /
        Condicional) e o porquê. É um carimbo determinístico: não entra na busca,
        a Lia segue como regra.
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
            <label htmlFor={`pol-diretriz-${escopoId}`}>Justificativa</label>
            <textarea
              id={`pol-diretriz-${escopoId}`}
              rows={2}
              placeholder="ex.: Linha prioritária. Concorrentes em espuma são desclassificados."
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

// --- Regras estruturadas de cotacao --------------------------------

/** Converte texto de numero pt-BR ("28,5") em Number; vazio/ausente -> NaN. */
function paraNumero(v: string | undefined): number {
  return v ? Number(v.replace(",", ".")) : NaN;
}

const regraSchema = z
  .object({
    atributo: z.string().trim().min(1, "Informe o atributo."),
    tipo_regra: z.enum(["faixa", "opcional", "substituicao"]),
    valor_min: z.string().trim().optional(),
    valor_max: z.string().trim().optional(),
    substituicao: z.string().trim().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.tipo_regra === "faixa") {
      if (!val.valor_min && !val.valor_max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["valor_min"],
          message: "Informe ao menos um limite (mínimo ou máximo).",
        });
      }
      for (const campo of ["valor_min", "valor_max"] as const) {
        const v = val[campo];
        if (v && Number.isNaN(paraNumero(v))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [campo],
            message: "Use um número (ex.: 28 ou 28,5).",
          });
        }
      }
      const min = paraNumero(val.valor_min);
      const max = paraNumero(val.valor_max);
      if (!Number.isNaN(min) && !Number.isNaN(max) && min > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["valor_max"],
          message: "Máximo deve ser maior ou igual ao mínimo.",
        });
      }
    }
    if (val.tipo_regra === "substituicao" && !val.substituicao) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["substituicao"],
        message: "Descreva a substituição permitida.",
      });
    }
  });
type RegraValues = z.infer<typeof regraSchema>;

const REGRA_VAZIA: RegraValues = {
  atributo: "",
  tipo_regra: "faixa",
  valor_min: "",
  valor_max: "",
  substituicao: "",
};

function regraResumo(r: CotacaoRegra): string {
  if (r.tipo_regra === "faixa") {
    const min = r.valor_min != null ? r.valor_min : "−∞";
    const max = r.valor_max != null ? r.valor_max : "+∞";
    return `Faixa de ${min} a ${max}`;
  }
  if (r.tipo_regra === "substituicao") {
    return `Substituição: ${r.substituicao ?? ""}`;
  }
  return "Opcional (pode faltar no edital)";
}

function RegrasBlock({
  params,
  nivel,
  escopoId,
}: {
  params: ListParams;
  nivel: CotacaoNivel;
  escopoId: string;
}) {
  const regras = useRegras(params);
  const createRegra = useCreateRegra();
  const updateRegra = useUpdateRegra();
  const deleteRegra = useDeleteRegra();

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );

  const items = regras.data?.items ?? [];
  const formOpen = creating || editingId !== null;

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<RegraValues>({
    resolver: zodResolver(regraSchema),
    defaultValues: REGRA_VAZIA,
  });
  const tipo = watch("tipo_regra");

  function openCreate() {
    reset(REGRA_VAZIA);
    setEditingId(null);
    setCreating(true);
    setFeedback(null);
  }

  function openEdit(r: CotacaoRegra) {
    reset({
      atributo: r.atributo,
      tipo_regra: r.tipo_regra,
      valor_min: r.valor_min != null ? String(r.valor_min) : "",
      valor_max: r.valor_max != null ? String(r.valor_max) : "",
      substituicao: r.substituicao ?? "",
    });
    setCreating(false);
    setEditingId(r.id);
    setFeedback(null);
  }

  function closeForm() {
    setCreating(false);
    setEditingId(null);
    setFeedback(null);
  }

  async function onSubmit(values: RegraValues) {
    const input = {
      nivel,
      escopo_id: escopoId,
      atributo: values.atributo.trim(),
      tipo_regra: values.tipo_regra,
      valor_min:
        values.tipo_regra === "faixa" && values.valor_min
          ? paraNumero(values.valor_min)
          : null,
      valor_max:
        values.tipo_regra === "faixa" && values.valor_max
          ? paraNumero(values.valor_max)
          : null,
      substituicao:
        values.tipo_regra === "substituicao" && values.substituicao?.trim()
          ? values.substituicao.trim()
          : null,
    };
    try {
      if (editingId) {
        await updateRegra.mutateAsync({ id: editingId, input });
      } else {
        await createRegra.mutateAsync(input);
      }
      closeForm();
    } catch {
      setFeedback({ kind: "err", msg: "Não foi possível salvar a regra." });
    }
  }

  async function onRemove(id: string) {
    setRemovingId(id);
    try {
      await deleteRegra.mutateAsync(id);
      if (editingId === id) closeForm();
    } catch {
      setFeedback({ kind: "err", msg: "Não foi possível remover a regra." });
    } finally {
      setRemovingId(null);
    }
  }

  const pending = createRegra.isPending || updateRegra.isPending;

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 8px" }}>
        <h3>Regras de cotação</h3>
        <span className="count">{items.length}</span>
        {!formOpen ? (
          <button
            type="button"
            className="btn btn-sm btn-icon"
            style={{ marginLeft: "auto" }}
            onClick={openCreate}
            aria-label="Nova regra"
            title="Nova regra"
          >
            <Plus aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p className="helper" style={{ margin: "0 0 14px" }}>
        Travas estruturadas e determinísticas: o que pode variar na cotação
        (faixa de medida, atributo opcional, substituição equivalente). Não entra
        na busca, a Lia segue como regra.
      </p>

      {regras.isLoading ? (
        <span className="skel skel-line" style={{ width: "70%" }} />
      ) : items.length === 0 ? null : (
        <div style={{ display: "grid", gap: 10, marginBottom: formOpen ? 14 : 0 }}>
          {items.map((r) => (
            <div
              key={r.id}
              className="card"
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                padding: "12px 14px",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: "12.5px", fontWeight: 600 }}>
                  {r.atributo}
                </p>
                <p className="sub" style={{ margin: "2px 0 0", fontSize: "12px" }}>
                  {regraResumo(r)}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-icon"
                style={{ color: "var(--accent)" }}
                onClick={() => openEdit(r)}
                aria-label="Editar regra"
                title="Editar"
              >
                <ChevronRight aria-hidden="true" />
              </button>
              <button
                type="button"
                className="btn btn-sm btn-icon"
                onClick={() => onRemove(r.id)}
                disabled={removingId === r.id}
                aria-label="Remover regra"
                title="Excluir"
              >
                {removingId === r.id ? (
                  <Loader2 className="spin" aria-hidden="true" />
                ) : (
                  <Trash2 aria-hidden="true" />
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      {formOpen && (
        <form
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          style={{ display: "grid", gap: 12 }}
        >
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`regra-tipo-${escopoId}`}>Tipo de regra</label>
            <select id={`regra-tipo-${escopoId}`} {...register("tipo_regra")}>
              {TIPO_REGRA.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <p className="helper" style={{ margin: "6px 0 0" }}>
              {TIPO_REGRA.find((t) => t.value === tipo)?.ajuda}
            </p>
          </div>

          <div
            className={cn("field", errors.atributo && "invalid")}
            style={{ marginBottom: 0 }}
          >
            <label htmlFor={`regra-atributo-${escopoId}`}>Atributo</label>
            <input
              id={`regra-atributo-${escopoId}`}
              type="text"
              placeholder="ex.: dimensão, gramatura, composição"
              aria-invalid={Boolean(errors.atributo)}
              {...register("atributo")}
            />
            {errors.atributo && (
              <div className="err-msg">
                <TriangleAlert aria-hidden="true" />
                {errors.atributo.message}
              </div>
            )}
          </div>

          {tipo === "faixa" && (
            <div className="grid-dlh g2" style={{ gap: 12 }}>
              <div
                className={cn("field", errors.valor_min && "invalid")}
                style={{ marginBottom: 0 }}
              >
                <label htmlFor={`regra-min-${escopoId}`}>Mínimo</label>
                <input
                  id={`regra-min-${escopoId}`}
                  type="text"
                  inputMode="decimal"
                  placeholder="ex.: 28"
                  aria-invalid={Boolean(errors.valor_min)}
                  {...register("valor_min")}
                />
                {errors.valor_min && (
                  <div className="err-msg">
                    <TriangleAlert aria-hidden="true" />
                    {errors.valor_min.message}
                  </div>
                )}
              </div>
              <div
                className={cn("field", errors.valor_max && "invalid")}
                style={{ marginBottom: 0 }}
              >
                <label htmlFor={`regra-max-${escopoId}`}>Máximo</label>
                <input
                  id={`regra-max-${escopoId}`}
                  type="text"
                  inputMode="decimal"
                  placeholder="ex.: 32"
                  aria-invalid={Boolean(errors.valor_max)}
                  {...register("valor_max")}
                />
                {errors.valor_max && (
                  <div className="err-msg">
                    <TriangleAlert aria-hidden="true" />
                    {errors.valor_max.message}
                  </div>
                )}
              </div>
            </div>
          )}

          {tipo === "substituicao" && (
            <div
              className={cn("field", errors.substituicao && "invalid")}
              style={{ marginBottom: 0 }}
            >
              <label htmlFor={`regra-subst-${escopoId}`}>
                Substituição permitida
              </label>
              <textarea
                id={`regra-subst-${escopoId}`}
                rows={2}
                placeholder="ex.: aceita gel ou silicone no lugar de espuma viscoelástica."
                aria-invalid={Boolean(errors.substituicao)}
                {...register("substituicao")}
              />
              {errors.substituicao && (
                <div className="err-msg">
                  <TriangleAlert aria-hidden="true" />
                  {errors.substituicao.message}
                </div>
              )}
            </div>
          )}

          <div className="form-foot" style={{ marginTop: 2 }}>
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              <span>{editingId ? "Salvar regra" : "Adicionar regra"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={closeForm}
              disabled={pending}
            >
              <X aria-hidden="true" />
              <span>Cancelar</span>
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
        </form>
      )}
    </div>
  );
}
