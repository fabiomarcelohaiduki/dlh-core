"use client";

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { ExtracaoPanel } from "@/components/cockpit/extracao-panel";
import { ExtracaoConfigForm } from "@/components/cockpit/extracao-config-form";
import { AgendamentoExtracaoForm } from "@/components/cockpit/agendamento-extracao-form";
import type { AgendamentoExtracaoState, ConfigExtracaoState } from "@/lib/api/types";

/**
 * cmp-extracao-view — Tela de Extração com os parâmetros embutidos.
 *
 * Os parâmetros (agendamento da extração e config da camada 1) sao da propria
 * extracao, entao vivem AQUI, atras de um botao "Parâmetros" que abre um drawer
 * lateral — sem virar aba separada. O disparo manual nao entra no drawer: o
 * painel ja tem "Extrair pendentes agora" e "Extrair OCR agora".
 *
 * Pos-migracao local (28/06): UM unico agendamento de extracao. No PC, o
 * comando tika-ocr roda a extracao rapida + OCR juntos, entao nao ha mais
 * relogio de OCR separado.
 */
export function ExtracaoView({
  nomusConfigurado,
  configExtracao,
  agendamentoExtracao,
}: {
  nomusConfigurado: boolean;
  configExtracao: ConfigExtracaoState;
  agendamentoExtracao: AgendamentoExtracaoState;
}) {
  const [aberto, setAberto] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Fecha no Escape e devolve o foco ao botao que abriu (a11y de dialog).
  useEffect(() => {
    if (!aberto) return;
    const trigger = triggerRef.current;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setAberto(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [aberto]);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button
          ref={triggerRef}
          type="button"
          className="btn btn-sm"
          onClick={() => setAberto(true)}
          aria-haspopup="dialog"
          aria-expanded={aberto}
        >
          <SlidersHorizontal aria-hidden="true" />
          <span>Parâmetros</span>
        </button>
      </div>

      <ExtracaoPanel nomusConfigurado={nomusConfigurado} />

      {aberto ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Parâmetros de extração"
          onClick={() => setAberto(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "8vh 16px 16px",
            overflowY: "auto",
          }}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(560px, 100%)", maxWidth: 560 }}
          >
            <div className="section-title" style={{ margin: "0 0 16px" }}>
              <h3>Parâmetros de extração</h3>
              <button
                type="button"
                className="btn btn-sm btn-icon"
                style={{ marginLeft: "auto" }}
                onClick={() => setAberto(false)}
                aria-label="Fechar"
                title="Fechar"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div style={{ display: "grid", gap: 16 }}>
              <AgendamentoExtracaoForm initial={agendamentoExtracao} />
              <ExtracaoConfigForm initial={configExtracao} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
