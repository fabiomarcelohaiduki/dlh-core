import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ConfiguracoesEmpresaForm } from "@/components/cockpit/configuracoes-empresa-form";
import { ConfiguracoesIaForm } from "@/components/cockpit/configuracoes-ia-form";
import type { ConfigEmpresa } from "@/lib/api/types";

export const metadata: Metadata = { title: "Configurações da empresa" };

/** Linha lida de public.config_empresa (singleton institucional da DLH). */
interface ConfigEmpresaRow {
  razao_social: string | null;
  nome_fantasia: string | null;
  cnpj: string | null;
  inscricao_estadual: string | null;
  endereco: string | null;
  telefone: string | null;
  email: string | null;
  site: string | null;
  logo_base64: string | null;
  validade_padrao_dias: number | null;
  observacao_rodape: string | null;
}

/**
 * Hidratacao server-side (RLS) dos dados institucionais (singleton
 * config_empresa) para o cmp-configuracoes-empresa-form. Sem linha (improvavel —
 * ha seed) cai nos defaults (campos nulos, validade 30).
 */
async function loadConfigEmpresa(): Promise<ConfigEmpresa> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("config_empresa")
    .select(
      "razao_social, nome_fantasia, cnpj, inscricao_estadual, endereco, telefone, email, site, logo_base64, validade_padrao_dias, observacao_rodape",
    )
    .limit(1)
    .maybeSingle();

  const data = (raw ?? null) as ConfigEmpresaRow | null;

  return {
    razaoSocial: data?.razao_social ?? null,
    nomeFantasia: data?.nome_fantasia ?? null,
    cnpj: data?.cnpj ?? null,
    inscricaoEstadual: data?.inscricao_estadual ?? null,
    endereco: data?.endereco ?? null,
    telefone: data?.telefone ?? null,
    email: data?.email ?? null,
    site: data?.site ?? null,
    logoBase64: data?.logo_base64 ?? null,
    validadePadraoDias: data?.validade_padrao_dias ?? 30,
    observacaoRodape: data?.observacao_rodape ?? null,
  };
}

export default async function ConfiguracoesEmpresaPage() {
  const config = await loadConfigEmpresa();

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Configurações da empresa</h2>
          <p>
            Dados institucionais e logomarca da DLH usados no cabeçalho e rodapé
            da tabela de preços em PDF.
          </p>
        </div>
      </div>

      <ConfiguracoesEmpresaForm initial={config} />

      <ConfiguracoesIaForm />
    </section>
  );
}
