"use client";

import { TriangleAlert } from "lucide-react";
import { useConfiguracao } from "@/hooks/use-configuracao";

/**
 * OrgBanner — estado honesto EC-06. Quando a conta autenticada nao possui
 * vinculo de organizacao (`org_membership`), o bootstrap de preferencias falha
 * com uma mensagem especifica. Em vez de degradar para uma tela branca, exibimos
 * um aviso inline e mantemos a navegacao acessivel (o banner nao bloqueia nada).
 */
export function OrgBanner() {
  const { error } = useConfiguracao();

  const semOrg =
    error instanceof Error &&
    /organiza\u00e7\u00e3o|organizacao/i.test(error.message) &&
    /vinculad/i.test(error.message);

  if (!semOrg) return null;

  return (
    <div className="org-banner" role="status" aria-live="polite">
      <TriangleAlert aria-hidden="true" width={18} height={18} />
      <div className="org-banner-copy">
        <strong>Sem organização vinculada</strong>
        <span>
          Sua conta ainda não está associada a uma organização. A navegação
          continua disponível, mas as preferências do ambiente ficam
          indisponíveis até o vínculo ser criado.
        </span>
      </div>
    </div>
  );
}
