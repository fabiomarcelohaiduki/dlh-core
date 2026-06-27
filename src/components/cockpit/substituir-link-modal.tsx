"use client";

import { useState } from "react";
import { Check, Link2, Loader2, TriangleAlert, X } from "lucide-react";
import { useSubstituirLink } from "@/hooks/use-documentos";
import type { ExtracaoItem } from "@/lib/api/documentos";
import { ApiError } from "@/lib/api/client";

/**
 * cmp-substituir-link-modal — correcao manual de URL de anexo Effecti com link
 * quebrado. Caso de uso: o portal republicou o edital e a URL que a Effecti
 * capturou morreu (5xx/404); o humano cola o link atual do portal. Ao salvar,
 * o Edge troca a ref_obtencao.url do vinculo, zera o contador e o devolve para
 * 'pendente' (sai de Erros/Inacessiveis, volta para a fila ate o proximo drain).
 * So Effecti (unica fonte com link de portal trocavel).
 */
export function SubstituirLinkModal({
  item,
  onClose,
}: {
  item: ExtracaoItem;
  onClose: () => void;
}) {
  const substituir = useSubstituirLink();
  const [url, setUrl] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  // Valida no cliente antes de mandar (o Edge revalida): so http/https.
  function urlValida(raw: string): boolean {
    try {
      const u = new URL(raw.trim());
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  const valido = urlValida(url);

  async function salvar() {
    if (!valido || substituir.isPending) return;
    setErro(null);
    try {
      await substituir.mutateAsync({ id: item.id, url: url.trim() });
      onClose();
    } catch (err) {
      let message = "Não foi possível substituir o link. Tente novamente.";
      if (err instanceof ApiError && err.status === 422) {
        message = "URL inválida ou anexo não elegível para substituição.";
      } else if (err instanceof ApiError && err.status === 404) {
        message = "Vínculo não encontrado. Atualize a lista e tente de novo.";
      }
      setErro(message);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Substituir link do anexo"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "var(--modal-backdrop)",
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
        style={{ width: "min(560px, 100%)", maxWidth: 560, boxShadow: "var(--shadow-overlay)" }}
      >
        <div className="section-title" style={{ margin: "0 0 14px" }}>
          <h3>Substituir link do anexo</h3>
          <button
            type="button"
            className="btn btn-sm btn-icon"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Fechar"
            title="Fechar"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="field">
          <label>Anexo</label>
          <div className="helper" style={{ fontWeight: 600, color: "var(--text-fg)" }}>
            {item.nomeAnexo ?? "—"}
          </div>
          {item.url ? (
            <div className="helper" style={{ wordBreak: "break-all", marginTop: 4 }}>
              Link atual (quebrado): {item.url}
            </div>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="nova-url-anexo">Nova URL</label>
          <input
            id="nova-url-anexo"
            type="text"
            inputMode="url"
            autoFocus
            placeholder="https://portal.gov.br/anexos/..."
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setErro(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") salvar();
            }}
          />
          <div className="helper">
            Cole o link atual do anexo no portal de origem. Ao salvar, o anexo
            volta para a fila (Pendentes) e será reprocessado no próximo drain.
          </div>
        </div>

        {erro ? (
          <div
            className="helper"
            style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--err)" }}
          >
            <TriangleAlert aria-hidden="true" style={{ width: 14, height: 14 }} />
            {erro}
          </div>
        ) : url.trim() !== "" && !valido ? (
          <div className="helper" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <TriangleAlert aria-hidden="true" style={{ width: 14, height: 14 }} />
            Informe uma URL válida (http ou https).
          </div>
        ) : null}

        <div className="form-foot" style={{ marginTop: 18 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={salvar}
            disabled={!valido || substituir.isPending}
            aria-disabled={!valido || substituir.isPending}
          >
            {substituir.isPending ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            <span>{substituir.isPending ? "Salvando…" : "Substituir link"}</span>
          </button>
          <button type="button" className="btn" onClick={onClose}>
            <Link2 aria-hidden="true" />
            <span>Cancelar</span>
          </button>
        </div>
      </div>
    </div>
  );
}
