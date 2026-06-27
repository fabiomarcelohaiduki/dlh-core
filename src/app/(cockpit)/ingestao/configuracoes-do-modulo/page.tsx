import type { Metadata } from "next";
import { MODULE_CONFIGS } from "@/lib/cockpit-config";
import { ModuleConfigView } from "@/components/cockpit/config/module-config-view";

export const metadata: Metadata = {
  title: `Configurações do módulo · ${MODULE_CONFIGS.ingestao.label}`,
};

/**
 * Wrapper estático de Ingestão para `configuracoes-do-modulo`.
 *
 * A rota dinâmica `/[modulo]/configuracoes-do-modulo` não atinge `ingestao`
 * porque a pasta estática `ingestao/` vence a precedência do Next. Este wrapper
 * renderiza a MESMA `ModuleConfigView` com o módulo fixado — sem duplicar
 * lógica de configuração.
 */
export default function IngestaoConfiguracoesDoModuloPage() {
  return <ModuleConfigView modulo="ingestao" />;
}
