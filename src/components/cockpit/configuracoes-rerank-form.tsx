"use client";

import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  Layers,
  Loader2,
  ListOrdered,
  TriangleAlert,
} from "lucide-react";
import { useConfigBusca, useUpdateConfigBusca } from "@/hooks/use-config-busca";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ConfigBuscaInput } from "@/lib/api/types";

const MODELO_DEFAULT = "rerank-v3.5";
// Allowlist de modelos Cohere suportados (espelha RERANK_MODELOS no backend).
const MODELOS = [
  { value: "rerank-v3.5", label: "rerank-v3.5 (multilíngue)" },
  { value: "rerank-multilingual-v3.0", label: "rerank-multilingual-v3.0" },
  { value: "rerank-english-v3.0", label: "rerank-english-v3.0" },
] as const;
const CANDIDATOS_DEFAULT = 50;
const CANDIDATOS_MIN = 1;
const CANDIDATOS_MAX = 50;
const LEXICAL_DEFAULT = 50;

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
  const [hibrida, setHibrida] = useState(false);
  const [candidatosLex, setCandidatosLex] = useState(LEXICAL_DEFAULT);
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
    setHibrida(data.hibridaAtiva);
    setCandidatosLex(data.hibridaCandidatosLexical || LEXICAL_DEFAULT);
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

    if (
      !Number.isInteger(candidatosLex) ||
      candidatosLex < CANDIDATOS_MIN ||
      candidatosLex > CANDIDATOS_MAX
    ) {
      setFeedback({
        kind: "err",
        message: `Candidatos lexicais deve ser entre ${CANDIDATOS_MIN} e ${CANDIDATOS_MAX}.`,
      });
      return;
    }

    const input: ConfigBuscaInput = {
      rerankAtivo: ativo,
      rerankModelo: modelo.trim() || MODELO_DEFAULT,
      rerankCandidatos: candidatos,
      hibridaAtiva: hibrida,
      hibridaCandidatosLexical: candidatosLex,
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
      <section className="cfg-panel-card">
        <div className="cfg-panel-body">
          <div
            className="helper"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <Loader2 className="spin" aria-hidden="true" />
            <span>Carregando configuração de rerank…</span>
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
            Não foi possível carregar a configuração de rerank.
          </div>
        </div>
      </section>
    );
  }

  return (
    <form className="cfg-panel-card" onSubmit={onSubmit} noValidate>
      <div className="panel-header">
        <div className="panel-title">
          <h3>Reranking da busca</h3>
          <p>
            Reordena os resultados da busca semântica por relevância real
            (Cohere), melhorando a precisão. Desligado, a busca usa apenas o
            vetorial. A chave fica guardada de forma cifrada e nunca é exibida.
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
          <select
            id="rerank-modelo"
            value={modelo}
            onChange={(e) => setModelo(e.target.value)}
          >
            {MODELOS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="helper">Modelo de rerank da Cohere.</div>
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

      <div className="section-title" style={{ marginTop: 24 }}>
        <h3>
          <Layers aria-hidden="true" />
          Busca híbrida
        </h3>
      </div>
      <p className="helper" style={{ marginTop: 2, marginBottom: 14 }}>
        Combina o vetorial (significado) com a busca lexical (termo exato:
        número de edital, UASG, CATMAT, CNPJ) por fusão RRF. Desligada, a busca
        usa apenas o vetorial. O rerank, quando ativo, roda depois da fusão.
      </p>

      <label className="chk" style={{ maxWidth: 320 }}>
        <input
          type="checkbox"
          checked={hibrida}
          onChange={(e) => setHibrida(e.target.checked)}
        />
        <div className="t">Busca híbrida ativa</div>
      </label>

      <div className="grid-fields" style={{ marginTop: 14 }}>
        <div className="field">
          <label htmlFor="hibrida-candidatos">Candidatos lexicais</label>
          <div className="input-affix">
            <input
              type="number"
              id="hibrida-candidatos"
              min={CANDIDATOS_MIN}
              max={CANDIDATOS_MAX}
              disabled={!hibrida}
              value={Number.isNaN(candidatosLex) ? "" : candidatosLex}
              onChange={(e) =>
                setCandidatosLex(e.target.value === "" ? Number.NaN : Number(e.target.value))
              }
            />
            <span className="suffix">chunks</span>
          </div>
          <div className="helper">
            Entre {CANDIDATOS_MIN} e {CANDIDATOS_MAX}. Chunks que a perna lexical traz para a fusão.
          </div>
        </div>
      </div>

      <div className="field" style={{ marginTop: 18 }}>
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
        <button
          className="btn btn-primary"
          type="submit"
          disabled={salvar.isPending || faltaChave}
        >
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
      </div>
    </form>
  );
}
