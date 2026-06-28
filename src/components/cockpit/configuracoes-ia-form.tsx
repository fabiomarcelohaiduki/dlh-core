"use client";

import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  Loader2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useConfigLlm, useUpdateConfigLlm } from "@/hooks/use-config-llm";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ConfigLlmInput } from "@/lib/api/types";

const MODELO_DEFAULT = "gpt-4o-mini";
const MAX_PALAVRAS_DEFAULT = 40;
const MAX_PALAVRAS_MIN = 10;
const MAX_PALAVRAS_MAX = 300;

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-configuracoes-ia-form — card de configuracao da IA (LLM) usada nas
 * geracoes assistidas do cockpit (ex: descricao comercial de produto).
 * Administravel sem hardcode: provedor (OpenAI no MVP), modelo, liga/desliga
 * e a chave da API. A chave NUNCA volta ao cliente — quando ja gravada, a
 * tela so sinaliza "configurada" e oferece substituir.
 */
export function ConfiguracoesIaForm() {
  const { data, isLoading, isError } = useConfigLlm();
  const salvar = useUpdateConfigLlm();

  const [ativo, setAtivo] = useState(false);
  const [modelo, setModelo] = useState(MODELO_DEFAULT);
  const [maxPalavras, setMaxPalavras] = useState(MAX_PALAVRAS_DEFAULT);
  const [keyConfigurada, setKeyConfigurada] = useState(false);
  const [substituindo, setSubstituindo] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // Hidrata o formulario quando a config chega (singleton).
  useEffect(() => {
    if (!data) return;
    setAtivo(data.ativo);
    setModelo(data.modelo || MODELO_DEFAULT);
    setMaxPalavras(data.descricaoMaxPalavras || MAX_PALAVRAS_DEFAULT);
    setKeyConfigurada(data.key_configurada);
    setSubstituindo(false);
    setApiKey("");
  }, [data]);

  // Campo de chave aparece quando ainda nao ha chave ou ao substituir.
  const mostraCampoChave = !keyConfigurada || substituindo;
  // Ligar a IA sem chave gravada e sem digitar uma agora nao faz sentido.
  const faltaChave = ativo && !keyConfigurada && apiKey.trim() === "";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);

    if (faltaChave) {
      setFeedback({ kind: "err", message: "Informe a chave da API para ativar a IA." });
      return;
    }

    if (
      !Number.isInteger(maxPalavras) ||
      maxPalavras < MAX_PALAVRAS_MIN ||
      maxPalavras > MAX_PALAVRAS_MAX
    ) {
      setFeedback({
        kind: "err",
        message: `Tamanho da descrição deve ser entre ${MAX_PALAVRAS_MIN} e ${MAX_PALAVRAS_MAX} palavras.`,
      });
      return;
    }

    const input: ConfigLlmInput = {
      provider: "openai",
      modelo: modelo.trim() || MODELO_DEFAULT,
      ativo,
      descricaoMaxPalavras: maxPalavras,
    };
    const chave = apiKey.trim();
    if (chave !== "") input.apiKey = chave;

    try {
      const res = await salvar.mutateAsync(input);
      setKeyConfigurada(res.key_configurada);
      setSubstituindo(false);
      setApiKey("");
      setFeedback({ kind: "ok", message: "Configuração de IA salva." });
    } catch (err) {
      const message =
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? "Dados inválidos: revise os campos."
          : "Não foi possível salvar a configuração de IA. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  if (isLoading) {
    return (
      <section className="cfg-panel-card">
        <div className="cfg-panel-body">
          <div
            className="helper"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <Loader2 className="spin" aria-hidden="true" />
            <span>Carregando configuração de IA…</span>
          </div>
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="cfg-panel-card">
        <div className="cfg-panel-body">
          <div className="err-msg" style={{ display: "flex" }}>
            <TriangleAlert aria-hidden="true" />
            Não foi possível carregar a configuração de IA.
          </div>
        </div>
      </section>
    );
  }

  return (
    <form className="cfg-panel-card" onSubmit={onSubmit} noValidate>
      <div className="panel-header">
        <div className="panel-title">
          <h3>Inteligência artificial</h3>
          <p>
            Provedor e chave usados nas gerações assistidas (ex.: descrição
            comercial de produtos). A chave fica guardada de forma cifrada e
            nunca é exibida.
          </p>
        </div>
      </div>
      <div className="cfg-panel-body">
      <label className="chk" style={{ maxWidth: 320 }}>
        <input
          type="checkbox"
          checked={ativo}
          onChange={(e) => setAtivo(e.target.checked)}
        />
        <div className="t">IA ativa</div>
      </label>

      <div className="grid-fields" style={{ marginTop: 14 }}>
        <div className="field">
          <label htmlFor="ia-provider">Provedor</label>
          <input type="text" id="ia-provider" value="OpenAI" disabled readOnly />
          <div className="helper">Único provedor disponível no momento.</div>
        </div>

        <div className="field">
          <label htmlFor="ia-modelo">Modelo</label>
          <input
            type="text"
            id="ia-modelo"
            placeholder={MODELO_DEFAULT}
            value={modelo}
            onChange={(e) => setModelo(e.target.value)}
          />
          <div className="helper">Ex.: gpt-4o-mini.</div>
        </div>

        <div className="field">
          <label htmlFor="ia-max-palavras">Tamanho máximo da descrição</label>
          <div className="input-affix">
            <input
              type="number"
              id="ia-max-palavras"
              min={MAX_PALAVRAS_MIN}
              max={MAX_PALAVRAS_MAX}
              value={Number.isNaN(maxPalavras) ? "" : maxPalavras}
              onChange={(e) =>
                setMaxPalavras(e.target.value === "" ? Number.NaN : Number(e.target.value))
              }
            />
            <span className="suffix">palavras</span>
          </div>
          <div className="helper">
            Entre {MAX_PALAVRAS_MIN} e {MAX_PALAVRAS_MAX}. ~40 palavras ≈ 3 a 4 linhas.
          </div>
        </div>
      </div>

      <div className="field">
        <label htmlFor="ia-key">Chave da API</label>
        {mostraCampoChave ? (
          <>
            <input
              type="password"
              id="ia-key"
              placeholder="sk-…"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <div className="helper">
              {keyConfigurada
                ? "Deixe em branco para manter a chave atual."
                : "Cole a chave secreta do provedor. Ela é gravada de forma cifrada."}
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
            <Sparkles aria-hidden="true" />
          )}
          <span>{salvar.isPending ? "Salvando…" : "Salvar configuração de IA"}</span>
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
      </div>
    </form>
  );
}
