"use client";

import type { CSSProperties } from "react";
import { Info } from "lucide-react";

/**
 * cmp-nomus-disparo-form — aviso de que o Nomus NAO tem disparo pelo cockpit.
 *
 * Pos-migracao 28/06 (saida do GitHub Actions): a coleta do Nomus passou a
 * rodar SO no PC local (Agendador de Tarefas do Windows -> coletar-nomus.mjs),
 * pois o Nomus so fala TLS CBC legado que a Edge do Supabase nao conecta e nao
 * ha canal cockpit -> PC. Por isso este widget virou informativo: nao dispara
 * nada. As props (recurso/janelaDias/fonteId) seguem aceitas para nao quebrar
 * os chamadores, mas sao ignoradas.
 */
export function NomusDisparoForm({
  bare = false,
}: {
  recurso?: string;
  janelaDias?: number | null;
  fonteId?: string | null;
  /** Renderiza sem o card proprio (para embutir num card externo). */
  bare?: boolean;
}) {
  const noteStyle: CSSProperties = {
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--faint)",
    maxWidth: 320,
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
    margin: 0,
  };

  const note = (
    <p className="helper" style={noteStyle}>
      <Info aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }} />
      Nomus é coletado no PC local (Agendador do Windows). Não há disparo manual
      pelo cockpit.
    </p>
  );

  return bare ? note : <div className="card form-card">{note}</div>;
}
