"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Bot, Check, Loader2, TriangleAlert } from "lucide-react";
import {
  useAutomacaoAgente,
  useUpdateAutomacaoAgente,
} from "@/hooks/use-automacao-agente";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { WidgetError } from "@/components/cockpit/widget-error";

const agenteSchema = z.object({
  ativo: z.boolean(),
  nome: z.string().trim().min(1, "Informe o nome do subagente."),
  personaPrompt: z.string().trim().min(1, "Informe a persona/prompt do subagente."),
  // Ferramentas: uma por linha no textarea; vazio = sem ferramentas.
  ferramentasTexto: z.string(),
});
type AgenteValues = z.infer<typeof agenteSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

/** Quebra o textarea de ferramentas (1 por linha) num array limpo. */
function parseFerramentas(texto: string): string[] {
  return texto
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * cmp-automacao-agente-form — persona versionada do subagente especialista
 * (E15) entregue pela FILA. Edita ativo, nome, persona/prompt e a lista de
 * ferramentas (uma por linha), exibindo a versao atual. Salva via
 * use-automacao-agente (o backend incrementa a versao e o hook invalida no
 * onSuccess). Hidrata do GET; estados loading/error tratados.
 */
export function AutomacaoAgenteForm() {
  const { data, isLoading, isError, refetch } = useAutomacaoAgente();
  const salvar = useUpdateAutomacaoAgente();

  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<AgenteValues>({
    resolver: zodResolver(agenteSchema),
    defaultValues: {
      ativo: false,
      nome: "",
      personaPrompt: "",
      ferramentasTexto: "",
    },
  });

  // Hidrata o formulario quando a persona chega (singleton versionado).
  useEffect(() => {
    if (!data) return;
    reset({
      ativo: data.ativo,
      nome: data.nome,
      personaPrompt: data.personaPrompt,
      ferramentasTexto: data.ferramentas.join("\n"),
    });
  }, [data, reset]);

  async function onSubmit(values: AgenteValues) {
    setFeedback(null);
    try {
      await salvar.mutateAsync({
        ativo: values.ativo,
        nome: values.nome.trim(),
        personaPrompt: values.personaPrompt.trim(),
        ferramentas: parseFerramentas(values.ferramentasTexto),
      });
      setFeedback({ kind: "ok", message: "Persona salva. Versão incrementada." });
    } catch (err) {
      const message =
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? "Dados inválidos: revise os campos."
          : "Não foi possível salvar a persona. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  if (isLoading) {
    return (
      <div className="card form-card form-card--wide">
        <div className="helper" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 className="spin" aria-hidden="true" />
          <span>Carregando persona do subagente…</span>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <WidgetError
        title="Não foi possível carregar"
        message="Não foi possível carregar a persona do subagente. Tente novamente."
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <form className="card form-card form-card--wide" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="section-title">
        <h3>
          <Bot aria-hidden="true" />
          Subagente especialista
        </h3>
        {data ? <span className="count">v{data.versao}</span> : null}
      </div>
      <p className="helper" style={{ marginTop: 2, marginBottom: 14 }}>
        Persona/prompt versionada do subagente entregue pela FILA. Cada
        atualização incrementa a versão.
      </p>

      <label className="chk" style={{ maxWidth: 320 }}>
        <input type="checkbox" {...register("ativo")} />
        <div className="t">Subagente ativo</div>
      </label>

      <div className={cn("field", errors.nome && "invalid")} style={{ marginTop: 14 }}>
        <label htmlFor="agente-nome">Nome</label>
        <input
          id="agente-nome"
          type="text"
          placeholder="ex.: Especialista em triagem de editais"
          aria-invalid={Boolean(errors.nome)}
          {...register("nome")}
        />
        <div className="err-msg">
          <TriangleAlert aria-hidden="true" />
          {errors.nome?.message ?? "Informe o nome do subagente."}
        </div>
      </div>

      <div className={cn("field", errors.personaPrompt && "invalid")}>
        <label htmlFor="agente-persona">Persona / prompt</label>
        <textarea
          id="agente-persona"
          rows={8}
          placeholder="Descreva como o subagente deve raciocinar e decidir o veredito…"
          aria-invalid={Boolean(errors.personaPrompt)}
          {...register("personaPrompt")}
        />
        <div className="err-msg">
          <TriangleAlert aria-hidden="true" />
          {errors.personaPrompt?.message ?? "Informe a persona/prompt do subagente."}
        </div>
      </div>

      <div className="field">
        <label htmlFor="agente-ferramentas">Ferramentas</label>
        <textarea
          id="agente-ferramentas"
          rows={4}
          placeholder={"busca-semantica\nconsulta-produto"}
          {...register("ferramentasTexto")}
        />
        <div className="helper">Uma ferramenta por linha. Deixe em branco para nenhuma.</div>
      </div>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={salvar.isPending}>
          {salvar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{salvar.isPending ? "Salvando…" : "Salvar persona"}</span>
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
  );
}
