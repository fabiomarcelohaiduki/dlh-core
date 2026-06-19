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

// Limites espelham o schema do servidor (automacao-agente-config) para falhar
// cedo no cliente, antes do PUT.
const agenteSchema = z.object({
  ativo: z.boolean(),
  nome: z
    .string()
    .trim()
    .min(1, "Informe o nome do subagente.")
    .max(200, "Nome muito longo (máx. 200 caracteres)."),
  personaPrompt: z
    .string()
    .trim()
    .min(1, "Informe a persona/prompt do subagente.")
    .max(10000, "Persona muito longa (máx. 10000 caracteres)."),
  instrucoesOperacionais: z
    .string()
    .trim()
    .min(1, "Informe as instruções operacionais (o método).")
    .max(20000, "Instruções muito longas (máx. 20000 caracteres)."),
});
type AgenteValues = z.infer<typeof agenteSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-automacao-agente-form — persona versionada do subagente especialista
 * (E15) entregue pela FILA. Edita ativo, nome, persona/prompt e as instrucoes
 * operacionais (metodo), exibindo a versao atual. Salva via
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
      instrucoesOperacionais: "",
    },
  });

  // Hidrata o formulario quando a persona chega (singleton versionado).
  useEffect(() => {
    if (!data) return;
    reset({
      ativo: data.ativo,
      nome: data.nome,
      personaPrompt: data.personaPrompt,
      instrucoesOperacionais: data.instrucoesOperacionais,
    });
  }, [data, reset]);

  async function onSubmit(values: AgenteValues) {
    setFeedback(null);
    try {
      await salvar.mutateAsync({
        ativo: values.ativo,
        nome: values.nome.trim(),
        personaPrompt: values.personaPrompt.trim(),
        instrucoesOperacionais: values.instrucoesOperacionais.trim(),
      });
      setFeedback({ kind: "ok", message: "Persona salva. Versão incrementada." });
    } catch (err) {
      // 400/422: propaga a mensagem específica do servidor (ex.: qual campo é
      // inválido); demais falhas usam o fallback genérico.
      const message =
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? err.message || "Dados inválidos: revise os campos."
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

      <div className={cn("field", errors.instrucoesOperacionais && "invalid")}>
        <label htmlFor="agente-instrucoes">Instruções operacionais (método)</label>
        <textarea
          id="agente-instrucoes"
          rows={12}
          placeholder="Os passos do modo atual que o subagente executa, na ordem…"
          aria-invalid={Boolean(errors.instrucoesOperacionais)}
          {...register("instrucoesOperacionais")}
        />
        <div className="err-msg">
          <TriangleAlert aria-hidden="true" />
          {errors.instrucoesOperacionais?.message ?? "Informe as instruções operacionais (o método)."}
        </div>
        <div className="helper">
          Método do modo entregue pela FILA. Vale na próxima execução da esteira;
          cada alteração incrementa a versão.
        </div>
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
