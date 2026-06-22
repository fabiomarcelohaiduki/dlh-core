"use client";

import { type CSSProperties } from "react";
import { FileText, TriangleAlert } from "lucide-react";
import { useIndexacaoResumoAvisos } from "@/hooks/use-indexacao";

const COUNTERS: ReadonlyArray<{ key: "pendente" | "emAndamento" | "concluida" | "erro"; label: string }> = [
  { key: "pendente", label: "Pendentes" },
  { key: "emAndamento", label: "Em andamento" },
  { key: "concluida", label: "Indexados" },
  { key: "erro", label: "Erros" },
];

/**
 * cmp-indexacao-avisos-resumo — Foto READ-ONLY da fila de indexacao dos AVISOS
 * (licitacoes Effecti).
 *
 * Os avisos sao uma tabela SEPARADA dos documentos (ciclo de indexacao
 * proprio, aviso_chunks). O painel de Indexacao so contava documentos -> um
 * furo de recall (avisos travados em status 'pendente' com 0 chunks) ficava
 * INVISIVEL e dizia "0 pendente para effecti". Este card surfa esse ponto
 * cego. Sem botao de disparo: o dreno de avisos e tratado a parte (script /
 * fase de backfill automatico). Aqui e puro alerta de visibilidade.
 */
export function IndexacaoAvisosResumo() {
  const resumo = useIndexacaoResumoAvisos();
  const c = resumo.data;
  const pendentes = c?.pendente ?? 0;
  const erros = c?.erro ?? 0;
  const temFuro = !resumo.isLoading && (pendentes > 0 || erros > 0);

  const capStyle: CSSProperties = {
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--faint)",
    maxWidth: 360,
  };

  return (
    <div className="card" style={{ display: "grid", gap: 14 }}>
      <div className="cfg-panel-head" style={{ margin: "0 0 2px" }}>
        <div
          className="avatar"
          style={{
            borderRadius: 9,
            width: 34,
            height: 34,
            color: "var(--accent)",
            background: "var(--accent-soft)",
            borderColor: "var(--accent-line)",
          }}
        >
          <FileText aria-hidden="true" />
        </div>
        <div style={{ flex: 1 }}>
          <b style={{ fontSize: 14.5 }}>Avisos (licitações Effecti)</b>
        </div>
      </div>

      {/* Foto da fila dos avisos por status_indexacao. */}
      <div className="chk-grid" role="group" aria-label="Resumo da indexação dos avisos">
        {COUNTERS.map((m) => (
          <div
            key={m.key}
            className="chk"
            style={{ cursor: "default", flexDirection: "column", alignItems: "flex-start", gap: 2 }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>
              {resumo.isLoading ? "—" : (c?.[m.key] ?? 0).toLocaleString("pt-BR")}
            </div>
            <div className="t" style={{ color: "var(--faint)" }}>
              {m.label}
            </div>
          </div>
        ))}
      </div>

      {temFuro ? (
        <span className="save-note err">
          <TriangleAlert aria-hidden="true" />
          {pendentes > 0
            ? `${pendentes.toLocaleString("pt-BR")} ${pendentes === 1 ? "aviso fora" : "avisos fora"} da fila de triagem (não indexados).`
            : `${erros.toLocaleString("pt-BR")} ${erros === 1 ? "aviso com erro" : "avisos com erro"} de indexação.`}
        </span>
      ) : null}

      <span className="helper" style={capStyle}>
        Os avisos têm indexação própria, separada dos anexos. Um aviso preso em
        pendente fica fora da fila de triagem. Esta contagem é o alerta; o dreno
        roda à parte.
      </span>
    </div>
  );
}
