"use client";

import { AutomacaoConfigForm } from "@/components/automacao/automacao-config-form";
import { AutomacaoAgenteForm } from "@/components/automacao/automacao-agente-form";
import { ConhecimentosManager } from "@/components/automacao/conhecimentos-manager";

/**
 * ConfigClient — aba Configuracao. Singleton da automacao (carencia, limiares,
 * K, interruptor de descarte fisico) + persona do subagente especialista
 * (E15) + base de conhecimento de dominio (entregue pela fila, setor
 * licitacao). Cada formulario consome seu proprio hook, trata loading/erro
 * (WidgetError) e salva de forma independente.
 */
export function ConfigClient() {
  return (
    <div style={{ display: "grid", gap: 22 }}>
      <AutomacaoConfigForm />
      <AutomacaoAgenteForm />
      <ConhecimentosManager setor="licitacao" />
    </div>
  );
}
