"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft, TriangleAlert, FileWarning } from "lucide-react";
import { useEdital } from "@/hooks/use-substrato";
import { ApiError } from "@/lib/api/client";
import { indexacaoDescriptor } from "@/lib/status";
import { formatNumber } from "@/lib/format";
import { derivePipeline } from "@/lib/pipeline";
import type { AvisoDetalhe } from "@/lib/api/types";
import { StatusPill } from "@/components/cockpit/status-pill";
import { PipelineIndicator } from "@/components/cockpit/pipeline-indicator";
import { CollapsibleContent } from "@/components/cockpit/collapsible-content";
import { ReprocessarButton } from "@/components/cockpit/reprocessar-button";

/** Serializa o payload bruto integral para exibicao no bloco monoespacado. */
function stringifyPayload(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function BackToErros({ router }: { router: ReturnType<typeof useRouter> }) {
  return (
    <button
      type="button"
      className="link"
      style={{ fontSize: "12.5px", marginBottom: 8 }}
      onClick={() => router.push("/erros")}
    >
      <ChevronLeft aria-hidden="true" />
      Voltar aos erros
    </button>
  );
}

export function EditalClient({ avisoId }: { avisoId: string }) {
  const router = useRouter();
  const edital = useEdital(avisoId);

  // -------- loading --------
  if (edital.isLoading) {
    return (
      <section className="screen">
        <div className="page-head">
          <div className="titles">
            <BackToErros router={router} />
            <span className="skel skel-line" style={{ width: 280, height: 22 }} />
            <span className="skel skel-line" style={{ width: 360, marginTop: 8 }} />
          </div>
        </div>
        <div className="section-title" style={{ marginTop: 0 }}>
          <h3>Pipeline do item</h3>
        </div>
        <div className="pipeline" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="pstep skip">
              <span className="skel" style={{ width: 24, height: 24, borderRadius: "50%" }} />
              <div className="pt" style={{ flex: 1 }}>
                <span className="skel skel-line" style={{ width: "60%" }} />
              </div>
            </div>
          ))}
        </div>
        <div className="grid-dlh g2" style={{ marginTop: 22 }}>
          {Array.from({ length: 2 }).map((_, i) => (
            <div className="card" key={i}>
              {Array.from({ length: 4 }).map((__, r) => (
                <span
                  key={r}
                  className="skel skel-line"
                  style={{ display: "block", margin: "10px 0", width: `${60 + (r % 3) * 12}%` }}
                />
              ))}
            </div>
          ))}
        </div>
      </section>
    );
  }

  // -------- error (avisoId inexistente / indisponivel) --------
  if (edital.isError || !edital.data) {
    const notFound = edital.error instanceof ApiError && edital.error.status === 404;
    return (
      <section className="screen">
        <div className="page-head">
          <div className="titles">
            <BackToErros router={router} />
            <h2>Detalhe do edital</h2>
          </div>
        </div>
        <div className="tbl-wrap">
          <div className="empty">
            <FileWarning aria-hidden="true" style={{ color: "var(--err)" }} />
            <h4>Edital não encontrado / indisponível</h4>
            <p>
              {notFound
                ? "Não há aviso com este identificador, ou ele não está mais disponível no substrato."
                : "Não foi possível carregar o detalhe do edital. Tente novamente em instantes."}
            </p>
            <div
              style={{ marginTop: 16, display: "flex", gap: 10, justifyContent: "center" }}
            >
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => router.push("/erros")}
              >
                Voltar aos erros
              </button>
              {!notFound ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => edital.refetch()}
                >
                  Tentar novamente
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    );
  }

  // -------- success --------
  return <EditalDetalhe detalhe={edital.data} router={router} />;
}

function EditalDetalhe({
  detalhe,
  router,
}: {
  detalhe: AvisoDetalhe;
  router: ReturnType<typeof useRouter>;
}) {
  const { indice } = detalhe;
  const status = indexacaoDescriptor(indice.statusIndexacao);
  const steps = derivePipeline(detalhe);

  const chunks = indice.chunks ?? [];
  const arquivos = indice.arquivos ?? [];
  const embeddingsOk = chunks.filter((c) => c.temEmbedding).length;

  const temVerbatim = detalhe.conteudoVerbatim.trim().length > 0;
  const payloadStr = stringifyPayload(detalhe.payloadBruto);
  const temPayload = payloadStr.length > 0;

  const indexFalhou = indice.statusIndexacao === "erro";

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <BackToErros router={router} />
          <h2>Detalhe do edital</h2>
          <p>
            Investigação do aviso a partir de um erro de ingestão · conteúdo verbatim,
            payload bruto integral e índice semântico.
          </p>
        </div>
        <div className="actions">
          <StatusPill state={status.state} label={status.label} />
        </div>
      </div>

      {indexFalhou ? (
        <div className="banner">
          <TriangleAlert aria-hidden="true" />
          <div>
            <b>Falha na etapa de indexação</b>
            <p>
              O conteúdo verbatim foi persistido integralmente; apenas o índice
              semântico ficou incompleto. Reprocessável sem nova coleta.
            </p>
          </div>
        </div>
      ) : null}

      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Pipeline do item</h3>
      </div>
      <PipelineIndicator steps={steps} />

      <div className="grid-dlh g2" style={{ marginTop: 22 }}>
        <div className="card">
          <div className="section-title" style={{ margin: "0 0 14px" }}>
            <h3>Identificação</h3>
          </div>
          <dl className="kv">
            <dt>Identificador</dt>
            <dd className="mono">{detalhe.id}</dd>
            <dt>Status de indexação</dt>
            <dd>
              <StatusPill state={status.state} label={status.label} />
            </dd>
            <dt>Conteúdo verbatim</dt>
            <dd>
              {temVerbatim ? (
                <StatusPill state="ok" label="Preservado" />
              ) : (
                <StatusPill state="idle" label="Ausente" />
              )}
            </dd>
            <dt>Payload bruto</dt>
            <dd>
              {temPayload ? (
                <StatusPill state="ok" label="Persistido integral" />
              ) : (
                <StatusPill state="idle" label="Ausente" />
              )}
            </dd>
          </dl>
        </div>

        <div className="card">
          <div className="section-title" style={{ margin: "0 0 14px" }}>
            <h3>Índice semântico</h3>
          </div>
          <dl className="kv">
            <dt>Chunks gerados</dt>
            <dd className="tnum">{formatNumber(chunks.length)}</dd>
            <dt>Embeddings OK</dt>
            <dd className="tnum">
              {formatNumber(embeddingsOk)} <span className="sub">/ {formatNumber(chunks.length)}</span>
            </dd>
            <dt>Arquivos do edital</dt>
            <dd className="tnum">{formatNumber(arquivos.length)}</dd>
          </dl>
          <ReprocessarButton avisoId={detalhe.id} />
        </div>
      </div>

      <div className="section-title">
        <h3>Conteúdo extraído</h3>
        <span className="count">verbatim · não resumido</span>
      </div>
      <div className="card">
        <p style={{ margin: "0 0 12px", fontSize: "12.5px", color: "var(--muted)" }}>
          Conteúdo preservado idêntico ao edital. Na Fase 1 não há resumo nem reescrita —
          apenas a segmentação para embeddings.
        </p>
        <CollapsibleContent
          content={detalhe.conteudoVerbatim}
          variant="text"
          label="conteúdo verbatim"
        />
      </div>

      <div className="section-title">
        <h3>Payload bruto da API</h3>
        <span className="count">US-19 · campos íntegros</span>
      </div>
      <CollapsibleContent content={payloadStr} variant="code" label="payload" />
    </section>
  );
}
