"use client";

import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Building2,
  Check,
  ImageUp,
  Loader2,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useUpdateConfigEmpresa } from "@/hooks/use-config-empresa";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ConfigEmpresa } from "@/lib/api/types";

/** Logo aceita (data URL) e teto pratico — base64 infla ~33% sobre o binario. */
const LOGO_MIME = /^image\/(png|jpe?g|svg\+xml|webp)$/;
const LOGO_MAX_BYTES = 1_500_000; // ~1,5 MB de binario antes de virar base64

/**
 * Campos textuais (a logo vive em estado proprio — e arquivo, nao texto).
 * Espelha configEmpresaSchema do backend; vazio vira null no onSubmit.
 */
const cfgSchema = z.object({
  razaoSocial: z.string().trim().max(200, "Razão social muito longa.").optional(),
  nomeFantasia: z.string().trim().max(200, "Nome fantasia muito longo.").optional(),
  cnpj: z.string().trim().max(40, "CNPJ muito longo.").optional(),
  inscricaoEstadual: z
    .string()
    .trim()
    .max(40, "Inscrição estadual muito longa.")
    .optional(),
  endereco: z.string().trim().max(400, "Endereço muito longo.").optional(),
  telefone: z.string().trim().max(60, "Telefone muito longo.").optional(),
  email: z.string().trim().max(160, "E-mail muito longo.").optional(),
  site: z.string().trim().max(200, "Site muito longo.").optional(),
  validadePadraoDias: z
    .number({ invalid_type_error: "Informe a validade em dias." })
    .int("Use um valor inteiro.")
    .min(0, "Não pode ser negativo.")
    .max(3650, "Máximo 3650 dias (10 anos)."),
  observacaoRodape: z
    .string()
    .trim()
    .max(1000, "Observação muito longa.")
    .optional(),
});
type CfgValues = z.infer<typeof cfgSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

function toDefaults(initial: ConfigEmpresa): CfgValues {
  return {
    razaoSocial: initial.razaoSocial ?? "",
    nomeFantasia: initial.nomeFantasia ?? "",
    cnpj: initial.cnpj ?? "",
    inscricaoEstadual: initial.inscricaoEstadual ?? "",
    endereco: initial.endereco ?? "",
    telefone: initial.telefone ?? "",
    email: initial.email ?? "",
    site: initial.site ?? "",
    validadePadraoDias: initial.validadePadraoDias ?? 30,
    observacaoRodape: initial.observacaoRodape ?? "",
  };
}

/** "" / espaços -> null; texto real e mantido. */
function texto(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

/** Le o arquivo como data URL base64 (FileReader). */
function lerComoDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("falha ao ler o arquivo"));
    reader.readAsDataURL(file);
  });
}

/**
 * cmp-configuracoes-empresa-form — dados institucionais da DLH (singleton
 * config_empresa). Campos textuais + upload da logomarca (data URL base64
 * em coluna, sem bucket). Alimentam o cabecalho/rodape da tabela de precos
 * em PDF. Salvar persiste e vale na proxima geracao.
 */
export function ConfiguracoesEmpresaForm({ initial }: { initial: ConfigEmpresa }) {
  const salvar = useUpdateConfigEmpresa();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [logo, setLogo] = useState<string | null>(initial.logoBase64);
  const [logoDirty, setLogoDirty] = useState(false);
  const [logoErro, setLogoErro] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<CfgValues>({
    resolver: zodResolver(cfgSchema),
    defaultValues: toDefaults(initial),
  });

  async function onArquivo(e: React.ChangeEvent<HTMLInputElement>) {
    setLogoErro(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!LOGO_MIME.test(file.type)) {
      setLogoErro("Formato inválido. Use PNG, JPEG, SVG ou WEBP.");
      e.target.value = "";
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoErro("Arquivo muito grande. Máximo ~1,5 MB.");
      e.target.value = "";
      return;
    }
    try {
      const dataUrl = await lerComoDataUrl(file);
      setLogo(dataUrl);
      setLogoDirty(true);
    } catch {
      setLogoErro("Não foi possível ler o arquivo. Tente outro.");
    } finally {
      e.target.value = "";
    }
  }

  function removerLogo() {
    setLogo(null);
    setLogoDirty(true);
    setLogoErro(null);
  }

  async function onSubmit(values: CfgValues) {
    setFeedback(null);
    try {
      await salvar.mutateAsync({
        razaoSocial: texto(values.razaoSocial),
        nomeFantasia: texto(values.nomeFantasia),
        cnpj: texto(values.cnpj),
        inscricaoEstadual: texto(values.inscricaoEstadual),
        endereco: texto(values.endereco),
        telefone: texto(values.telefone),
        email: texto(values.email),
        site: texto(values.site),
        logoBase64: logo,
        validadePadraoDias: values.validadePadraoDias,
        observacaoRodape: texto(values.observacaoRodape),
      });
      reset(values);
      setLogoDirty(false);
      setFeedback({ kind: "ok", message: "Configuração salva · vale na próxima geração." });
    } catch (err) {
      const message =
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? "Dados inválidos: revise os campos destacados."
          : "Não foi possível salvar a configuração. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  const dirty = isDirty || logoDirty;

  return (
    <form className="card form-card form-card--wide" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="field">
        <label>Logomarca</label>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 4 }}>
          <div
            style={{
              width: 132,
              height: 84,
              borderRadius: 8,
              border: "1px dashed var(--border)",
              background: "var(--surface-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logo}
                alt="Logomarca da DLH"
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              />
            ) : (
              <Building2 aria-hidden="true" style={{ color: "var(--faint)" }} />
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => fileRef.current?.click()}
              >
                <ImageUp aria-hidden="true" />
                <span>{logo ? "Trocar logo" : "Enviar logo"}</span>
              </button>
              {logo && (
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ color: "var(--err)" }}
                  onClick={removerLogo}
                >
                  <Trash2 aria-hidden="true" />
                  <span>Remover</span>
                </button>
              )}
            </div>
            <div className="helper">PNG, JPEG, SVG ou WEBP. Máximo ~1,5 MB.</div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            onChange={onArquivo}
            style={{ display: "none" }}
          />
        </div>
        {logoErro && (
          <div className="err-msg" style={{ display: "flex" }}>
            <TriangleAlert aria-hidden="true" />
            {logoErro}
          </div>
        )}
      </div>

      <div className="grid-fields" style={{ marginTop: 14 }}>
        <div className={cn("field", errors.razaoSocial && "invalid")}>
          <label htmlFor="ce-razao">Razão social</label>
          <input
            type="text"
            id="ce-razao"
            aria-invalid={Boolean(errors.razaoSocial)}
            {...register("razaoSocial")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.razaoSocial?.message}
          </div>
        </div>

        <div className={cn("field", errors.nomeFantasia && "invalid")}>
          <label htmlFor="ce-fantasia">Nome fantasia</label>
          <input
            type="text"
            id="ce-fantasia"
            aria-invalid={Boolean(errors.nomeFantasia)}
            {...register("nomeFantasia")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.nomeFantasia?.message}
          </div>
        </div>
      </div>

      <div className="grid-fields">
        <div className={cn("field", errors.cnpj && "invalid")}>
          <label htmlFor="ce-cnpj">CNPJ</label>
          <input
            type="text"
            id="ce-cnpj"
            placeholder="00.000.000/0000-00"
            aria-invalid={Boolean(errors.cnpj)}
            {...register("cnpj")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.cnpj?.message}
          </div>
        </div>

        <div className={cn("field", errors.inscricaoEstadual && "invalid")}>
          <label htmlFor="ce-ie">Inscrição estadual</label>
          <input
            type="text"
            id="ce-ie"
            aria-invalid={Boolean(errors.inscricaoEstadual)}
            {...register("inscricaoEstadual")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.inscricaoEstadual?.message}
          </div>
        </div>
      </div>

      <div className={cn("field", errors.endereco && "invalid")}>
        <label htmlFor="ce-endereco">Endereço</label>
        <input
          type="text"
          id="ce-endereco"
          placeholder="Rua, número, bairro, cidade/UF, CEP"
          aria-invalid={Boolean(errors.endereco)}
          {...register("endereco")}
        />
        <div className="err-msg">
          <TriangleAlert aria-hidden="true" />
          {errors.endereco?.message}
        </div>
      </div>

      <div className="grid-fields">
        <div className={cn("field", errors.telefone && "invalid")}>
          <label htmlFor="ce-tel">Telefone</label>
          <input
            type="text"
            id="ce-tel"
            aria-invalid={Boolean(errors.telefone)}
            {...register("telefone")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.telefone?.message}
          </div>
        </div>

        <div className={cn("field", errors.email && "invalid")}>
          <label htmlFor="ce-email">E-mail</label>
          <input
            type="text"
            id="ce-email"
            aria-invalid={Boolean(errors.email)}
            {...register("email")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.email?.message}
          </div>
        </div>
      </div>

      <div className="grid-fields">
        <div className={cn("field", errors.site && "invalid")}>
          <label htmlFor="ce-site">Site</label>
          <input
            type="text"
            id="ce-site"
            placeholder="www.dlh.com.br"
            aria-invalid={Boolean(errors.site)}
            {...register("site")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.site?.message}
          </div>
        </div>

        <div className={cn("field", errors.validadePadraoDias && "invalid")}>
          <label htmlFor="ce-validade">Validade padrão da proposta</label>
          <div className="input-affix">
            <input
              type="number"
              id="ce-validade"
              min={0}
              max={3650}
              aria-invalid={Boolean(errors.validadePadraoDias)}
              {...register("validadePadraoDias", { valueAsNumber: true })}
            />
            <span className="suffix">dias</span>
          </div>
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.validadePadraoDias?.message ?? "Entre 0 e 3650 dias."}
          </div>
          <div className="helper">Prazo de validade impresso na tabela de preços.</div>
        </div>
      </div>

      <div className={cn("field", errors.observacaoRodape && "invalid")}>
        <label htmlFor="ce-rodape">Observação do rodapé</label>
        <textarea
          id="ce-rodape"
          rows={3}
          aria-invalid={Boolean(errors.observacaoRodape)}
          {...register("observacaoRodape")}
        />
        <div className="err-msg">
          <TriangleAlert aria-hidden="true" />
          {errors.observacaoRodape?.message}
        </div>
        <div className="helper">Texto livre exibido no rodapé do PDF (condições, contato, etc.).</div>
      </div>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={salvar.isPending}>
          {salvar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Building2 aria-hidden="true" />
          )}
          <span>{salvar.isPending ? "Salvando…" : "Salvar configurações"}</span>
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            reset(toDefaults(initial));
            setLogo(initial.logoBase64);
            setLogoDirty(false);
            setLogoErro(null);
            setFeedback(null);
          }}
          disabled={!dirty || salvar.isPending}
        >
          Descartar alterações
        </button>
        {feedback && (
          <span className={cn("save-note", feedback.kind === "err" && "err")}>
            {feedback.kind === "err" ? (
              <TriangleAlert aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {feedback.message}
          </span>
        )}
      </div>
    </form>
  );
}
