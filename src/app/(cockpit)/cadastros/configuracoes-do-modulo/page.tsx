import type { Metadata } from "next";
import { MODULE_CONFIGS } from "@/lib/cockpit-config";
import { ModuleConfigView } from "@/components/cockpit/config/module-config-view";

export const metadata: Metadata = {
  title: `Configurações do módulo · ${MODULE_CONFIGS.cadastros.label}`,
};

/**
 * Wrapper estático de Cadastros para `configuracoes-do-modulo`.
 *
 * A rota dinâmica `/[modulo]/configuracoes-do-modulo` não atinge `cadastros`
 * porque a pasta estática `cadastros/` vence a precedência do Next. Este wrapper
 * renderiza a MESMA `ModuleConfigView` com o módulo fixado — sem duplicar
 * lógica de configuração.
 */
export default function CadastrosConfiguracoesDoModuloPage() {
  return <ModuleConfigView modulo="cadastros" />;
}
