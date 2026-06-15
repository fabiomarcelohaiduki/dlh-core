"use client";

import { useRef, useState } from "react";
import { Download, ImageOff, Loader2, Trash2, TriangleAlert, Upload } from "lucide-react";
import { useDeleteFoto, useFotos, useUploadFoto } from "@/hooks/use-fotos";
import { ApiError } from "@/lib/api/client";
import type { ProdutoImagem } from "@/lib/api/types";

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = ["image/jpeg", "image/png", "image/webp"];

function nomeArquivo(foto: ProdutoImagem): string {
  let ext = "jpg";
  try {
    const m = new URL(foto.signed_url!).pathname.match(/\.(\w+)$/);
    if (m) ext = m[1];
  } catch {
    // signed_url ausente ou malformada: mantem extensao padrao
  }
  const base = foto.legenda?.trim()
    ? foto.legenda.trim().replace(/[^\w.-]+/g, "_")
    : `foto-${foto.ordem}`;
  return `${base}.${ext}`;
}

/**
 * cmp-fotos-uploader — upload, ordenacao e legenda das fotos de um Produto ou
 * SKU (produto_imagens, bucket privado via signed URL). A ordem e definida no
 * envio (sem endpoint de update) e a galeria e exibida ordenada. Validacao na
 * borda (5MB, jpeg/png/webp). Remocao apaga apenas a foto, sem afetar o
 * cadastro. Estado "sem fotos" quando vazio.
 */
export function FotosUploader({
  produtoId,
  skuId,
}: {
  produtoId?: string;
  skuId?: string;
}) {
  const params = skuId ? { sku_id: skuId } : { produto_id: produtoId };
  const fotos = useFotos(params);
  const uploadFoto = useUploadFoto();
  const deleteFoto = useDeleteFoto();

  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [legenda, setLegenda] = useState("");
  const [ordem, setOrdem] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const items = [...(fotos.data?.items ?? [])].sort((a, b) => a.ordem - b.ordem);

  function onPick(selected: File | null) {
    setErro(null);
    if (!selected) {
      setFile(null);
      return;
    }
    if (!ACCEPT.includes(selected.type)) {
      setErro("Formato inválido. Use JPEG, PNG ou WebP.");
      setFile(null);
      return;
    }
    if (selected.size > MAX_BYTES) {
      setErro("Arquivo acima de 5 MB.");
      setFile(null);
      return;
    }
    setFile(selected);
  }

  async function onUpload() {
    if (!file) {
      setErro("Selecione uma imagem.");
      return;
    }
    setErro(null);
    const ordemNum = ordem.trim() === "" ? items.length : Number(ordem);
    try {
      await uploadFoto.mutateAsync({
        file,
        produto_id: skuId ? undefined : produtoId,
        sku_id: skuId,
        ordem: Number.isNaN(ordemNum) ? items.length : ordemNum,
        legenda: legenda.trim() || undefined,
      });
      setFile(null);
      setLegenda("");
      setOrdem("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 400
          ? "Upload rejeitado: confira formato, tamanho e limite de fotos."
          : "Não foi possível enviar a foto. Tente novamente.",
      );
    }
  }

  async function onRemove(foto: ProdutoImagem) {
    setRemovingId(foto.id);
    try {
      await deleteFoto.mutateAsync(foto.id);
    } catch {
      setErro("Não foi possível remover a foto.");
    } finally {
      setRemovingId(null);
    }
  }

  async function onDownload(foto: ProdutoImagem) {
    if (!foto.signed_url) return;
    setErro(null);
    try {
      const res = await fetch(foto.signed_url);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = nomeArquivo(foto);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch {
      setErro("Não foi possível baixar a foto.");
    }
  }

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Fotos</h3>
        <span className="count">{items.length} / 10</span>
      </div>

      {fotos.isLoading ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <span
              key={i}
              className="skel"
              style={{ height: 120, borderRadius: "var(--r-sm)" }}
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <ImageOff aria-hidden="true" />
          <h4>Sem fotos</h4>
          <p>Envie imagens abaixo para compor a ficha visual.</p>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: 12,
          }}
        >
          {items.map((foto) => (
            <figure
              key={foto.id}
              className="card"
              style={{ margin: 0, padding: 8, display: "grid", gap: 8 }}
            >
              {foto.signed_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- signed URL temporaria do Storage privado; otimizacao do next/image dispensavel aqui.
                <img
                  src={foto.signed_url}
                  alt={foto.legenda ?? "Foto do produto"}
                  style={{
                    width: "100%",
                    height: 120,
                    objectFit: "cover",
                    borderRadius: "var(--r-sm)",
                    display: "block",
                  }}
                />
              ) : (
                <div
                  style={{
                    height: 120,
                    display: "grid",
                    placeItems: "center",
                    background: "var(--surface-2)",
                    borderRadius: "var(--r-sm)",
                    color: "var(--faint)",
                  }}
                >
                  <ImageOff aria-hidden="true" />
                </div>
              )}
              <figcaption
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span className="sub" style={{ minWidth: 0, flex: 1 }}>
                  <span className="tnum">#{foto.ordem}</span>
                  {foto.legenda ? ` · ${foto.legenda}` : ""}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onDownload(foto)}
                  disabled={!foto.signed_url}
                  aria-label="Baixar foto"
                >
                  <Download aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onRemove(foto)}
                  disabled={removingId === foto.id}
                  aria-label="Remover foto"
                >
                  {removingId === foto.id ? (
                    <Loader2 className="spin" aria-hidden="true" />
                  ) : (
                    <Trash2 aria-hidden="true" />
                  )}
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <div
        className="grid-fields"
        style={{
          gridTemplateColumns: "1fr 1fr 90px auto",
          alignItems: "end",
          gap: 12,
          marginTop: 16,
        }}
      >
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="foto-file">Imagem</label>
          <input
            id="foto-file"
            ref={fileRef}
            type="file"
            accept={ACCEPT.join(",")}
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="foto-legenda">Legenda</label>
          <input
            id="foto-legenda"
            type="text"
            placeholder="Opcional"
            value={legenda}
            onChange={(e) => setLegenda(e.target.value)}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="foto-ordem">Ordem</label>
          <input
            id="foto-ordem"
            type="number"
            placeholder={String(items.length)}
            value={ordem}
            onChange={(e) => setOrdem(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onUpload}
          disabled={uploadFoto.isPending || !file}
        >
          {uploadFoto.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Upload aria-hidden="true" />
          )}
          <span>Enviar</span>
        </button>
      </div>
      {erro && (
        <div className="err-msg" style={{ display: "flex", marginTop: 12 }}>
          <TriangleAlert aria-hidden="true" />
          {erro}
        </div>
      )}
    </div>
  );
}
