"use client";

import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  Loader2,
  ListOrdered,
  TriangleAlert,
} from "lucide-react";
import { useConfigBusca, useUpdateConfigBusca } from "@/hooks/use-config-busca";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ConfigBuscaInput } from "@/lib/api/types";

const MODELO_DEFAULT = "rerank-v3.5";
const CANDIDATOS_DEFAULT = 50;
const CANDIDATOS_MIN = 1;
const CANDIDATOS_MAX = 50;

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-configuracoes-rerank-form — card do RERANKING da busca semantica do
 * acervo (Cohere). Administravel sem hardcode: liga/desliga, modelo, numero
 * de candidatos que o vetorial traz antes do rerank e a chave da API. A chave
 * NUNCA volta ao cliente — quando ja gravada, a tela so sinaliza "configurada"
 * e oferece substituir. Com o rerank desligado, a busca usa vetorial puro.
 */
export function ConfiguracoesRerankForm() {
  const { data, isLoading, isError } = useConfigBusca();
  const salvar = useUpdateConfigBusca();

  const [ativo, setAtivo] = useState(true);
  const [modelo, setModelo] = useState(MODELO_DEFAULT);
  const [candidatos, setCandidatos] = useState(CANDIDATOS_DEFAULT);
  const [keyConfigurada, setKeyConfigurada] = useState(false);
  const [substituindo, setSubstituindo] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // Hidrata o formulario quando a config chega (singleton).
  useEffect(() => {
    if (!data) return;
    setAtivo(data.rerankAtivo);
    setModelo(data.rerankModelo || MODELO_DEFAULT);
    setCandidatos(data.rerankCandidatos || CANDIDATOS_DEFAULT);
    setKeyConfigurada(data.key_configurada);
    setSubstituindo(false);
    setApiKey("");
  }, [data]);

  // Campo de chave aparece quando ainda nao ha chave ou ao substituir.
  const mostraCampoChave = !keyConfigurada || substituindo;
  // Ligar o rerank sem chave gravada e sem digitar uma agora nao faz sentido.
  const faltaChave = ativo && !keyConfigurada && apiKey.trim() === "";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);

    if (faltaChave) {
      setFeedback({ kind: "err", message: "Informe a chave da Cohere para ativar o rerank." });
      return;
    }

    if (
      !Number.isInteger(candidatos) ||
      candidatos < CANDIDATOS_MIN ||
      candidatos > CANDIDATOS_MAX
    ) {
      setFeedback({
        kind: "err",
        message: `Número de candidatos deve ser entre ${CANDIDATOS_MIN} e ${CANDIDATOS_MAX}.`,
      });
      return;
    }

    const input: ConfigBuscaInput = {
      rerankAtivo: ativo,
      rerankModelo: modelo.trim() || MODELO_DEFAULT,
      rerankCandidatos: candidatos,
    };
    const chave = apiKey.trim();
    if (chave !== "") input.apiKey = chave;

    try {
      const res = await salvar.mutateAsync(input);
      setKeyConfigurada(res.key_configurada);
      setSubstituindo(false);
      setApiKey("");
      setFeedback({ kind: "ok", message: "Configuração de rerank salva." });
    } catch (err) {
      const message =
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? "Dados inválidos: revise os campos."
          : "Não foi possível salvar a configuração de rerank. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  if (isLoading) {
    return (
      <div className="card form-card form-card--wide">
        <div
          className="helper"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <Loader2 className="spin" aria-hidden="true" />
          <span>Carregando configuração de rerank…</span>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="card form-card form-card--wide">
        <div className="err-msg" style={{ display: "flex" }}>
          <TriangleAlert aria-hidden="true" />
          Não foi possível carregar a configuração de rerank.
        </div>
      </div>
    );
  }

  return (
    <form className="card form-card form-card--wide" onSubmit={onSubmit} noValidate>
      <div className="section-title">
        <h3>
          <ListOrdered aria-hidden="true" />
          Reranking da busca
        </h3>
      </div>
      <p className="helper" style={{ marginTop: 2, marginBottom: 14 }}>
        Reordena os resultados da busca semântica por relevância real (Cohere),
        melhorando a precisão. Desligado, a busca usa apenas o vetorial. A chave
        fica guardada de forma cifrada e nunca é exibida.
      </p>

      <label className="chk" style={{ maxWidth: 320 }}>
        <input
          type="checkbox"
          checked={ativo}
          onChange={(e) => setAtivo(e.target.checked)}
        />
        <div className="t">Rerank ativo</div>
      </label>

      <div className="grid-fields" style={{ marginTop: 14 }}>
        <div className="field">
          <label htmlFor="rerank-provider">Provedor</label>
          <input type="text" id="rerank-provider" value="Cohere" disabled readOnly />
          <div className="helper">Único provedor disponível no momento.</div>
        </div>

        <div className="field">
          <label htmlFor="rerank-modelo">Modelo</label>
          <input
            type="text"
            id="rerank-modelo"
            placeholder={MODELO_DEFAULT}
            value={modelo}
            onChange={(e) => setModelo(e.target.value)}
          />
          <div className="helper">Ex.: rerank-v3.5.</div>
        </div>

        <div className="field">
          <label htmlFor="rerank-candidatos">Candidatos antes do rerank</label>
          <div className="input-affix">
            <input
              type="number"
              id="rerank-candidatos"
              min={CANDIDATOS_MIN}
              max={CANDIDATOS_MAX}
              value={Number.isNaN(candidatos) ? "" : candidatos}
              onChange={(e) =>
                setCandidatos(e.target.value === "" ? Number.NaN : Number(e.target.value))
              }
            />
            <span className="suffix">chunks</span>
          </div>
          <div className="helper">
            Entre {CANDIDATOS_MIN} e {CANDIDATOS_MAX}. Mais candidatos = mais recall para reordenar.
          </div>
        </div>
      </div>

      <div className="field">
        <label htmlFor="rerank-key">Chave da API</label>
        {mostraCampoChave ? (
          <>
            <input
              type="password"
              id="rerank-key"
              placeholder="cohere-…"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <div className="helper">
              {keyConfigurada
                ? "Deixe em branco para manter a chave atual."
                : "Cole a chave secreta da Cohere. Ela é gravada de forma cifrada."}
            </div>
            {keyConfigurada && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: 8, alignSelf: "flex-start" }}
                onClick={() => {
                  setSubstituindo(false);
                  setApiKey("");
                }}
              >
                <span>Cancelar substituição</span>
              </button>
            )}
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            <span className="save-note">
              <Check aria-hidden="true" />
              Chave configurada
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setSubstituindo(true)}
            >
              <KeyRound aria-hidden="true" />
              <span>Substituir</span>
            </button>
          </div>
        )}
      </div>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={salvar.isPending}>
          {salvar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <ListOrdered aria-hidden="true" />
          )}
          <span>{salvar.isPending ? "Salvando…" : "Salvar configuração de rerank"}</span>
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
