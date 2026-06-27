import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MODULE_CONFIGS, isModuloId } from "@/lib/cockpit-config";
import { ModuleConfigView } from "@/components/cockpit/config/module-config-view";

/**
 * View configuracoes-do-modulo (/[modulo]/configuracoes-do-modulo) — delta-15/28.
 *
 * Rota dinâmica única que serve Automações (Ingestão e Cadastros usam wrappers
 * estáticos irmãos por colidirem com as pastas `ingestao/` e `cadastros/`).
 * Valida o módulo da URL; fora dos 3 módulos canônicos retorna 404. O conteúdo
 * é o `ModuleConfigView` compartilhado (sem duplicação de lógica por módulo).
 */
export function generateStaticParams() {
  return [{ modulo: "automacoes" }];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ modulo: string }>;
}): Promise<Metadata> {
  const { modulo } = await params;
  if (!isModuloId(modulo)) return { title: "Configurações do módulo" };
  return { title: `Configurações do módulo · ${MODULE_CONFIGS[modulo].label}` };
}

export default async function ConfiguracoesDoModuloPage({
  params,
}: {
  params: Promise<{ modulo: string }>;
}) {
  const { modulo } = await params;
  if (!isModuloId(modulo)) notFound();
  return <ModuleConfigView modulo={modulo} />;
}
