import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * cc-row — linha de controle da Configuração geral (Design Lock).
 *
 * Layout em grid `1fr auto`: à esquerda a cópia (título + descrição), à direita
 * os controles. Suporta:
 *  - `muted`: linha dependente desativada (opacity .5 + pointer-events none),
 *    usada quando a linha-mãe está desligada (ex.: frequência sob auto-sync off);
 *  - `sub`: linha aninhada (indentada) com separador tracejado;
 *  - `level`: badge textual opcional (GLOBAL/LINHA/PRODUTO etc.).
 */
export function CcRow({
  title,
  description,
  controls,
  muted = false,
  sub = false,
  level,
}: {
  title: string;
  description: string;
  controls: ReactNode;
  muted?: boolean;
  sub?: boolean;
  level?: string;
}) {
  return (
    <div className={cn("cc-row", sub && "is-sub", muted && "is-muted")}>
      <span className="cc-copy">
        <strong>
          {title}
          {level ? <span className="cc-level">{level}</span> : null}
        </strong>
        <span>{description}</span>
      </span>
      <span className="cc-controls">{controls}</span>
    </div>
  );
}
