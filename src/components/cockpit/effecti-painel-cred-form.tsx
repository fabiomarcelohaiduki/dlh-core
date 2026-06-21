"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { useSalvarPainelCredEffecti } from "@/hooks/use-admin";
import { ApiError } from "@/lib/api/client";

type PainelCredValues = { username: string; password: string };

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * Schema cliente da credencial do painel (espelha o backend): usuario e senha
 * nao-vazios apos trim no usuario. Bloqueia o submit vazio antes do servidor
 * (defesa em profundidade).
 */
const painelCredSchema = z.object({
  username: z.string().trim().min(1, "Informe o usuário do painel Effecti."),
  password: z.string().min(1, "Informe a senha do painel Effecti."),
});

/**
 * cmp-effecti-painel-cred-form — Credencial do PAINEL WEB da Effecti
 * (usuario + senha), distinta do token de API. Habilita o login programatico
 * (usuario/senha -> JWT) que abre o endpoint /all com a lista COMPLETA de itens
 * por edital (recall total), que a API de integracao por token nao entrega.
 *
 * Seguranca (RNF-02): a credencial salva nunca volta ao cliente. Quando ja ha
 * credencial (`configurado`), exibe o estado mascarado com a acao 'Substituir';
 * cancelar a substituicao mantem o valor salvo.
 */
export function EffectiPainelCredForm({ configurado: configInicial }: { configurado: boolean }) {
  const salvar = useSalvarPainelCredEffecti();

  const [configurado, setConfigurado] = useState(configInicial);
  // Sem credencial: input ja nasce aberto. Com credencial: mascarado.
  const [editing, setEditing] = useState(!configInicial);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors },
  } = useForm<PainelCredValues>({
    resolver: zodResolver(painelCredSchema),
    defaultValues: { username: "", password: "" },
  });

  async function onSubmit(values: PainelCredValues) {
    setFeedback(null);
    try {
      await salvar.mutateAsync({ username: values.username, password: values.password });
      setConfigurado(true);
      setEditing(false);
      reset({ username: "", password: "" });
      setFeedback({ kind: "ok", message: "Credencial do painel salva." });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 422
          ? "Informe usuário e senha do painel Effecti."
          : "Não foi possível salvar a credencial do painel. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  function startReplace() {
    setEditing(true);
    setFeedback(null);
    reset({ username: "", password: "" });
    setTimeout(() => setFocus("username"), 0);
  }

  function cancelReplace() {
    // Cancelar a substituicao mantem o valor salvo (volta ao mascarado).
    setEditing(false);
    reset({ username: "", password: "" });
  }

  const saving = salvar.isPending;

  return (
    <div className="card form-card">
      <div className="section-title" style={{ marginTop: 0 }}>
        Credencial do painel web
      </div>
      <p className="helper" style={{ marginTop: -4, marginBottom: 14, maxWidth: 520 }}>
        Login do painel da Effecti (usuário e senha), separado do token de API. Habilita a leitura
        da lista completa de itens por edital direto do painel.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        {editing ? (
          <>
            <div className={`field${errors.username ? " invalid" : ""}`}>
              <label htmlFor="effecti-painel-user">Usuário</label>
              <div className="input-affix">
                <input
                  type="text"
                  id="effecti-painel-user"
                  placeholder="Usuário do painel Effecti"
                  autoComplete="off"
                  aria-invalid={Boolean(errors.username)}
                  {...register("username")}
                />
              </div>
              <div className="err-msg">
                <TriangleAlert aria-hidden="true" />
                {errors.username?.message}
              </div>
            </div>

            <div className={`field${errors.password ? " invalid" : ""}`}>
              <label htmlFor="effecti-painel-pass">Senha</label>
              <div className="input-affix">
                <input
                  type="password"
                  id="effecti-painel-pass"
                  placeholder="Senha do painel Effecti"
                  autoComplete="new-password"
                  aria-invalid={Boolean(errors.password)}
                  {...register("password")}
                />
              </div>
              <div className="err-msg">
                <TriangleAlert aria-hidden="true" />
                {errors.password?.message}
              </div>
              <div className="helper">
                Usuário e senha são armazenados cifrados no Supabase Vault e nunca exibidos após
                salvos.
              </div>
            </div>
          </>
        ) : (
          <div className="field">
            <label>Credencial configurada</label>
            <div
              className="input-affix"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                height: 40,
                padding: "0 13px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--r-sm)",
                color: "var(--muted)",
              }}
            >
              <KeyRound aria-hidden="true" style={{ width: 15, height: 15, flex: "none" }} />
              <span className="mono" style={{ fontSize: 13 }}>
                •••••••••••••• cifrado no Vault
              </span>
            </div>
            <div className="helper">
              A credencial do painel está salva. Use “Substituir credencial” para trocá-la.
            </div>
          </div>
        )}

        <div className="form-foot cred-actions">
          {editing ? (
            <>
              <button className="btn btn-primary" type="submit" disabled={saving}>
                {saving ? (
                  <Loader2 className="spin" aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                <span>{saving ? "Salvando…" : "Salvar credencial do painel"}</span>
              </button>
              {configurado && (
                <button className="btn" type="button" onClick={cancelReplace} disabled={saving}>
                  Cancelar
                </button>
              )}
            </>
          ) : (
            <button className="btn" type="button" onClick={startReplace}>
              <KeyRound aria-hidden="true" />
              <span>Substituir credencial</span>
            </button>
          )}
        </div>

        {feedback && (
          <div style={{ marginTop: 14 }}>
            <span className={`save-note${feedback.kind === "err" ? " err" : ""}`}>
              {feedback.kind === "err" ? (
                <TriangleAlert aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {feedback.message}
            </span>
          </div>
        )}
      </form>
    </div>
  );
}
