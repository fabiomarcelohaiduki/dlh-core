"use client";

// =====================================================================
// IndexacaoRegistroDetalhe — detalhe expandido (linha-irmã no mesmo tbody) de
// UM registro da guia "Indexação". Espelha o drill-down da guia "Dados", mas
// no eixo EMBEDDINGS: abre o X/Y de anexos da linha mestra em uma lista, com o
// status de indexação INDIVIDUAL de cada anexo, e mostra também o status do
// CORPO (aviso Effecti / descrição Nomus) quando o registro tem corpo.
//
// O corpo é instantâneo (vem da linha mestra, `corpoStatus`); os anexos são
// LAZY (a query só dispara porque este componente só monta quando a linha está
// expandida). nomus/pessoas não tem anexos próprios na view -> lista vazia.
// =====================================================================

import { Loader2, TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/cockpit/status-pill";
import { useIndexacaoRegistroDetalhe } from "@/hooks/use-indexacao-registros";
import type {
  IndexacaoRegistroItem,
  IndexacaoStatusConsolidado,
} from "@/lib/api/indexacao";
import { indexacaoConsolidadoDescriptor } from "@/lib/status";

// O corpoStatus cru (avisos/nomus.status_indexacao) traduzido para o mesmo
// vocabulário consolidado dos anexos, para reusar o indexacaoConsolidadoDescriptor.
function normalizarCorpo(raw: string): IndexacaoStatusConsolidado {
  switch (raw) {
    case "concluida":
    case "indexado":
      return "indexado";
    case "em_andamento":
      return "indexando";
    case "erro":
      return "erro";
    default:
      return "pendente";
  }
}

export function IndexacaoRegistroDetalhe({
  item,
  panelId,
}: {
  item: IndexacaoRegistroItem;
  panelId: string;
}) {
  const detalhe = useIndexacaoRegistroDetalhe(item.idComposto, {
    fonte: item.fonte,
    recurso: item.recurso,
    registroOrigemId: item.registroOrigemId,
  });

  const anexos = detalhe.data?.anexos ?? [];
  const corpo = item.corpoStatus ? normalizarCorpo(item.corpoStatus) : null;
  const corpoDescriptor = corpo ? indexacaoConsolidadoDescriptor(corpo) : null;

  return (
    <tr>
      <td colSpan={6} style={{ padding: 0 }}>
        <section
          id={panelId}
          aria-label={`Detalhe da indexação de ${item.tituloCurto}`}
          className="flex flex-col gap-4 border-l-2 border-accent-line bg-surface-2 px-[18px] py-4"
        >
          {/* Corpo do registro (só quando há corpo indexável). */}
          {corpoDescriptor ? (
            <div className="flex flex-col gap-1">
              <h4 className="text-[11px] font-bold uppercase tracking-wide text-soft">
                Corpo
              </h4>
              <div className="flex items-center gap-2 text-[13px] text-fg">
                <span className="truncate">{item.tituloCurto}</span>
                <StatusPill state={corpoDescriptor.state} label={corpoDescriptor.label} />
              </div>
            </div>
          ) : null}

          {/* Anexos do registro com o status individual. */}
          <div className="flex flex-col gap-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wide text-soft">
              Anexos {item.anexosIndexavel > 0 ? `· ${item.anexosIndexados}/${item.anexosIndexavel}` : ""}
            </h4>

            {detalhe.isLoading ? (
              <div className="flex items-center gap-2 text-[13px] text-muted">
                <Loader2 className="spin size-4" aria-hidden="true" />
                <span>Carregando anexos…</span>
              </div>
            ) : detalhe.isError ? (
              <div className="flex items-center gap-2 text-[13px] text-muted">
                <TriangleAlert className="size-4" aria-hidden="true" />
                <span>Não foi possível carregar os anexos. </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => detalhe.refetch()}
                >
                  Tentar de novo
                </button>
              </div>
            ) : anexos.length === 0 ? (
              <p className="text-[13px] text-muted">
                Este registro não possui anexos indexáveis.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {anexos.map((anexo) => {
                  const d = indexacaoConsolidadoDescriptor(anexo.status);
                  return (
                    <li
                      key={anexo.id}
                      className="flex items-center justify-between gap-3 rounded-sm border border-border bg-surface px-3 py-2"
                    >
                      <span className="truncate text-[13px] text-fg" title={anexo.nome ?? undefined}>
                        {anexo.nome ?? "—"}
                      </span>
                      <StatusPill state={d.state} label={d.label} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </td>
    </tr>
  );
}
