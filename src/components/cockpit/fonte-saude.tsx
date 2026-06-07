"use client";

import { Loader2 } from "lucide-react";
import { useFontes } from "@/hooks/use-fontes";
import { conexaoDescriptor } from "@/lib/status";
import { formatDateTime } from "@/lib/format";
import { StatusPill } from "@/components/cockpit/status-pill";
import type { EstadoConexao, FonteTipo } from "@/lib/api/types";

/**
 * cmp-fonte-saude — Saude vigente da fonte (US-04). Le a lista de fontes
 * (useFontes -> RLS) e exibe o estado_conexao (pill) e a ultima_coleta_em. O
 * estado de conexao reflete o ultimo teste; a ultima coleta vem do pipeline.
 */
export function FonteSaude({ tipo }: { tipo: FonteTipo }) {
  const { data, isLoading } = useFontes();
  const fonte = data?.find((f) => f.tipo === tipo);

  const estado: EstadoConexao = fonte?.estadoConexao ?? "nao_configurada";
  const pill = conexaoDescriptor(estado);

  return (
    <dl className="kv">
      <dt>Conexão</dt>
      <dd>
        {isLoading ? (
          <span className="action-hint">
            <Loader2 className="spin" aria-hidden="true" />
            Carregando…
          </span>
        ) : (
          <StatusPill state={pill.state} label={pill.label} />
        )}
      </dd>
      <dt>Última coleta</dt>
      <dd className="tnum">
        {isLoading ? "—" : formatDateTime(fonte?.ultimaColetaEm ?? null)}
      </dd>
    </dl>
  );
}
