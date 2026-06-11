"use client";

import { useState, type CSSProperties } from "react";
import { Check, Loader2, Play, TriangleAlert } from "lucide-react";
import { useDispararDrive } from "@/hooks/use-admin";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-drive-disparo-form — Disparo MANUAL da coleta/descoberta do Drive.
 *
 * O Drive descobre num runner Node do GitHub Actions (a lista de arquivos e a
 * credencial Google so existem la). Este botao aciona o workflow proprio
 * coletar-drive.yml: o runner resolve as pastas ATIVAS do cockpit, lista cada
 * uma (recursivo) e enfileira os vinculos na fila de documentos (sem Tika). A
 * extracao (Tika) e disparada a parte (painel de Extracao).
 *
 * Diferente do Gmail/Nomus, a descoberta do Drive NAO grava linha em execucoes
 * (so enfileira vinculos), entao nao ha poll de "coleta em andamento": a defesa
 * contra duplo-disparo e o 409 do Edge (concurrency group + GitHub API).
 */
export function DriveDisparoForm({ bare = false }: { bare?: boolean }) {
  const disparar = useDispararDrive();
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function executar() {
    setFeedback(null);
    try {
      await disparar.mutateAsync();
      setFeedback({ kind: "ok", message: "Coleta disparada · descobre as pastas ativas na nuvem." });
    } catch (err) {
      let message = "Falha ao disparar a coleta. Tente novamente.";
      if (err instanceof ApiError && err.status === 409) {
        message = "Já há uma coleta do Drive em andamento; aguarde a conclusão.";
      } else if (err instanceof ApiError && err.status === 502) {
        message = "Não foi possível acionar o coletor na nuvem. Tente novamente.";
      }
      setFeedback({ kind: "err", message });
    }
  }

  const ocupado = disparar.isPending;

  // Legenda fixa sob o botao. O Drive nao tem janela/marca d'agua: re-lista as
  // pastas ativas inteiras e deduplica por file_id. Edicoes entram porque a
  // assinatura de versao (md5/modifiedTime) reabre o vinculo p/ re-extracao.
  // Mesmo formato do helper de campo (espelha o cmp-effecti/nomus-disparo-form).
  const capStyle: CSSProperties = {
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--faint)",
    maxWidth: 240,
  };
  const caption =
    "Re-lista as pastas ativas e enfileira arquivos novos e editados para extração.";

  const body = (
    <div
      className="form-foot"
      style={{ marginTop: 0, flexWrap: "wrap", alignItems: "flex-start" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button className="btn btn-primary" type="button" onClick={executar} disabled={ocupado}>
          {ocupado ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
          <span>{ocupado ? "Disparando…" : "Coletar Drive agora"}</span>
        </button>
        <span className="helper" style={capStyle}>{caption}</span>
      </div>

      {feedback ? (
        <span className={cn("save-note", feedback.kind === "err" && "err")}>
          {feedback.kind === "err" ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          {feedback.message}
        </span>
      ) : null}
    </div>
  );

  return bare ? body : <div className="card form-card">{body}</div>;
}
