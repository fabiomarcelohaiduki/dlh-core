import { Eye, Trash2 } from "lucide-react";

/**
 * cmp-modo-sombra-banner — Banner persistente do estado do descarte fisico
 * (US-10, RNF-12). Em modo sombra (default) os avisos na carencia NUNCA sao
 * apagados de fato; quando `ligado`, o job de descarte fisico esvazia a lixeira
 * apos a carencia. Reflete sempre `descarteFisicoLigado`.
 */
export function ModoSombraBanner({ ligado }: { ligado: boolean }) {
  return (
    <div className="banner" role="status" aria-live="polite">
      {ligado ? <Trash2 aria-hidden="true" /> : <Eye aria-hidden="true" />}
      <div>
        <b>Descarte físico: {ligado ? "ligado" : "modo sombra"}</b>
        <p>
          {ligado
            ? "Avisos na lixeira são apagados de fato após a carência."
            : "Nada é apagado de fato: a lixeira só registra o descarte previsto."}
        </p>
      </div>
    </div>
  );
}
