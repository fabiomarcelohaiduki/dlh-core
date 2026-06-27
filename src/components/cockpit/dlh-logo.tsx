"use client";

import { useId } from "react";

/**
 * cmp-dlh-logo — logo canonico do DLH Core (Contrato de Design, secao 1).
 *
 * Tile arredondado (gradiente do tema), orbita animada com dois nos e faisca
 * central (estrela de 4 pontas). A cor acompanha `--accent` do tema ativo; o
 * tile, nos e faisca derivam das superficies/acento via CSS (classes
 * `.tile-from/.tile-to/.spark-from/.spark-to/.logo-tile/.logo-node`).
 *
 * Variantes permitidas (DESIGN.md): `.logo` (login/destaque) e `.mini-logo`
 * (sidebar/topbar) — mesmo desenho, escalas diferentes. O wrapper com a classe
 * fica a cargo de quem usa; aqui renderizamos apenas o SVG.
 *
 * Os ids de gradiente sao unicos por instancia (useId) para nunca colidirem
 * quando mais de um logo coexiste no DOM (ex.: sidebar + topbar).
 */
export function DlhLogo({ size = 44 }: { size?: number }) {
  const uid = useId().replace(/:/g, "");
  const tileId = `dlhTile-${uid}`;
  const sparkId = `dlhSpark-${uid}`;

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="DLH Core"
      style={{ display: "block", width: "100%", height: "100%" }}
    >
      <defs>
        <linearGradient id={tileId} x1="0" y1="0" x2="0" y2="1">
          <stop className="tile-from" offset="0" />
          <stop className="tile-to" offset="1" />
        </linearGradient>
        <linearGradient id={sparkId} x1="0" y1="0" x2="1" y2="1">
          <stop className="spark-from" offset="0" />
          <stop className="spark-to" offset="1" />
        </linearGradient>
      </defs>
      <rect
        className="logo-tile"
        x="3.5"
        y="3.5"
        width="57"
        height="57"
        rx="15"
        fill={`url(#${tileId})`}
        strokeWidth="1"
      />
      <g className="orbit">
        <circle cx="32" cy="32" r="17.5" fill="none" stroke="currentColor" strokeOpacity="0.16" strokeWidth="1.2" />
        <path d="M32 32 47 17.5" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M32 32 17 46.5" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.4" strokeLinecap="round" />
        <circle className="logo-node" cx="47" cy="17.5" r="3.4" stroke="currentColor" strokeWidth="1.4" />
        <circle className="logo-node" cx="17" cy="46.5" r="3.4" stroke="currentColor" strokeWidth="1.4" />
      </g>
      <path
        d="M32 19 35.4 28.6 45 32 35.4 35.4 32 45 28.6 35.4 19 32 28.6 28.6Z"
        fill={`url(#${sparkId})`}
        stroke="currentColor"
        strokeOpacity="0.4"
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}
