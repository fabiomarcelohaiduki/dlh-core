import { ImageOff } from "lucide-react";

/**
 * cmp-foto-thumb — miniatura quadrada da foto (signed URL) usada nas listagens
 * de Linha/Produto/SKU. Placeholder (icone) quando sem foto. Tamanho via prop
 * (default 36px). Sem estado: e so apresentacao da URL ja resolvida no backend.
 */
export function FotoThumb({
  url,
  alt,
  size = 36,
}: {
  url?: string | null;
  alt?: string;
  size?: number;
}) {
  const box: React.CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: 8,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
  };

  if (!url) {
    return (
      <div style={box} aria-hidden="true">
        <ImageOff size={16} style={{ color: "var(--muted)" }} />
      </div>
    );
  }

  return (
    <div style={{ ...box, position: "relative" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt ?? ""}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      {/* vinheta interna: harmoniza fotos de fundo claro com o tema dark,
          escurecendo as bordas para que o branco nao "estoure" sobre o fundo */}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 8,
          pointerEvents: "none",
          boxShadow:
            "inset 0 0 0 1px rgba(0,0,0,.35), inset 0 0 10px 2px rgba(0,0,0,.30)",
        }}
      />
    </div>
  );
}
