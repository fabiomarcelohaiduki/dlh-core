"use client";

import { AutomacaoConfigForm } from "@/components/automacao/automacao-config-form";
import { AutomacaoAgenteForm } from "@/components/automacao/automacao-agente-form";

/**
 * ConfigClient — aba Configuracao. Singleton da automacao (carencia, limiares,
 * K, interruptor de descarte fisico) + persona do subagente especialista
 * (E15). Cada formulario consome seu proprio hook (use-automacao-config /
 * use-automacao-agente), trata loading/erro (WidgetError) e salva de forma
 * independente.
 */
export function ConfigClient() {
  return (
    <div style={{ display: "grid", gap: 22 }}>
      <AutomacaoConfigForm />
      <AutomacaoAgenteForm />
    </div>
  );
}
