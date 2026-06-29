"use client";

// =====================================================================
// ColetaRegistroDetalheExpansion — detalhe expandido (linha-irma no mesmo
// tbody) de UM registro coletado da guia "Dados".
//
// Renderiza, in-loco:
//   - CabecalhoDiscriminadoRenderer: uma sub-renderizacao por variante de
//     fonte (effecti / nomus / gmail / drive), a partir do cabecalho ja
//     presente na linha mestra (render instantaneo, sem esperar o detalhe);
//   - Acao "Reindexar aviso" (so Effecti, via useReprocessar);
//   - Tabela de vinculos por anexo (nome, pill via coletaStatusDescriptor,
//     link_original quando houver, "Reprocessar este anexo"/"Ignorar este
//     anexo") com allowlist de status por acao (SPEC 4.6);
//   - Secao de erros agregados (so quando ha erros);
//   - Secao de execucao_origem (so Effecti, quando presente).
//
// O detalhe (vinculos/erros/execucao) e LAZY: a query so dispara porque este
// componente so e montado quando a linha esta expandida. Em 404 a expansao se
// fecha (onClose); demais erros mostram WorkbenchTableError inline na tabela
// de vinculos, sem descartar a lista mestra.
// =====================================================================

import { useEffect, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { ApiError } from "@/lib/api/client";
import type {
  CabecalhoDiscriminado,
  RegistroColetado,
  StatusExtracao,
  VinculoDetalhe,
} from "@/lib/api/coleta-registros";
import { useColetaRegistroDetalhe } from "@/hooks/use-coleta-registros";
import { useReprocessarAnexo, useIgnorarAnexo } from "@/hooks/use-documentos";
import { useReprocessar } from "@/hooks/use-substrato";
import { coletaStatusDescriptor } from "@/lib/status";
import { StatusPill } from "@/components/cockpit/status-pill";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  WorkbenchSkeletonRows,
  WorkbenchTableEmpty,
  WorkbenchTableError,
  formatDateTime,
} from "./table-states";

/** Rotulo curto do "objeto" do registro para aria-labels das acoes. */
function registroObjeto(registro: RegistroColetado): string {
  const c = registro.cabecalho;
  if (c.fonte === "effecti") return c.objeto || registro.tituloCurto;
  return registro.tituloCurto;
}

// Allowlists de status_extracao por acao granular (SPEC 4.6). Fora delas, o
// botao fica disabled com title explicativo (sem toast); o backend tambem
// rejeita (422), mas a borda evita a chamada inutil.
const REPROCESSAVEL: ReadonlySet<StatusExtracao> = new Set<StatusExtracao>([
  "erro",
  "inobtenivel",
  "precisa_ocr",
  "pendente",
]);
const IGNORAVEL: ReadonlySet<StatusExtracao> = new Set<StatusExtracao>([
  "erro",
  "inobtenivel",
]);

const REPROCESSAR_BLOQUEIO_TITLE =
  "Só é possível reprocessar anexos pendentes, com erro, inobteníveis ou que precisam de OCR";
const IGNORAR_BLOQUEIO_TITLE =
  "Só é possível ignorar anexos com erro ou inobteníveis";

// ---------------------------------------------------------------------
// Cabecalho discriminado por fonte.
// ---------------------------------------------------------------------

/** Par rotulo/valor do cabecalho; omite valores nulos exibindo "—". */
function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-soft">
        {label}
      </dt>
      <dd className="text-[13px] text-fg">{value && value.trim() ? value : "—"}</dd>
    </div>
  );
}

/** Grid de pares rotulo/valor do cabecalho. */
function CabecalhoGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
      {children}
    </dl>
  );
}

/**
 * CabecalhoDiscriminadoRenderer — uma sub-renderizacao por variante de fonte.
 * Discrimina pelo campo `fonte` da discriminated union, garantindo cobertura
 * exaustiva das 4 fontes (effecti / nomus / gmail / drive).
 */
export function CabecalhoDiscriminadoRenderer({
  cabecalho,
}: {
  cabecalho: CabecalhoDiscriminado;
}) {
  switch (cabecalho.fonte) {
    case "effecti":
      return (
        <CabecalhoGrid>
          <Field label="Objeto" value={cabecalho.objeto} />
          <Field label="Órgão" value={cabecalho.orgao} />
          <Field label="Modalidade" value={cabecalho.modalidade} />
          <Field label="Portal" value={cabecalho.portal} />
          <Field label="UF" value={cabecalho.uf} />
          <Field label="UASG" value={cabecalho.uasg} />
          <Field label="Edital" value={cabecalho.edital} />
          <Field
            label="Publicação"
            value={
              cabecalho.dataPublicacao ? formatDateTime(cabecalho.dataPublicacao) : null
            }
          />
          <Field label="Captura" value={formatDateTime(cabecalho.dataCaptura)} />
        </CabecalhoGrid>
      );
    case "nomus":
      // Dentro de Nomus, o `recurso` discrimina o bloco renderizado.
      if (cabecalho.recurso === "pessoas") {
        return (
          <CabecalhoGrid>
            <Field label="Nome" value={cabecalho.nome} />
            <Field label="Documento (CNPJ)" value={cabecalho.cnpj} />
            <Field label="Tipo de pessoa" value={cabecalho.tipoPessoa} />
            <Field label="Município" value={cabecalho.municipio} />
            <Field label="UF" value={cabecalho.uf} />
            <Field label="Código" value={cabecalho.codigo} />
            <Field label="ID Nomus" value={cabecalho.nomusId} />
          </CabecalhoGrid>
        );
      }
      return (
        <CabecalhoGrid>
          <Field label="ID Nomus" value={cabecalho.nomusId} />
          <Field label="Etapa" value={cabecalho.etapa} />
          <Field label="Pessoa" value={cabecalho.pessoa} />
          <Field label="Tipo" value={cabecalho.tipo} />
          <Field
            label="Criação"
            value={cabecalho.dataCriacao ? formatDateTime(cabecalho.dataCriacao) : null}
          />
        </CabecalhoGrid>
      );
    case "gmail":
      return (
        <CabecalhoGrid>
          <Field label="Assunto" value={cabecalho.assunto} />
          <Field label="De" value={cabecalho.remetente} />
          <Field label="Para" value={cabecalho.destinatarios} />
          <Field label="Cópia" value={cabecalho.cc} />
          <Field
            label="Data do e-mail"
            value={cabecalho.dataEmail ? formatDateTime(cabecalho.dataEmail) : null}
          />
          <Field label="Anexo" value={cabecalho.nomeAnexo} />
          <Field label="Extensão" value={cabecalho.extensao} />
          <Field label="Tipo" value={cabecalho.tipo} />
          <Field label="Thread" value={cabecalho.threadId} />
        </CabecalhoGrid>
      );
    case "drive":
      return (
        <CabecalhoGrid>
          <Field label="Arquivo" value={cabecalho.nomeArquivo} />
          <Field label="Tipo MIME" value={cabecalho.mimeType} />
        </CabecalhoGrid>
      );
  }
}

// ---------------------------------------------------------------------
// Linha de vinculo (anexo) + acoes granulares.
// ---------------------------------------------------------------------

function VinculoRow({
  vinculo,
  reprocessando,
  ignorando,
  onReprocessar,
  onIgnorar,
}: {
  vinculo: VinculoDetalhe;
  reprocessando: boolean;
  ignorando: boolean;
  onReprocessar: () => void;
  onIgnorar: () => void;
}) {
  const descriptor = coletaStatusDescriptor(vinculo.statusExtracao);
  const podeReprocessar = REPROCESSAVEL.has(vinculo.statusExtracao);
  const podeIgnorar = IGNORAVEL.has(vinculo.statusExtracao);
  const algumEmAndamento = reprocessando || ignorando;

  return (
    <TableRow>
      <TableCell className="font-medium">
        <span className="flex items-center gap-2">
          <span className="truncate">{vinculo.nomeAnexo}</span>
          {vinculo.linkOriginal ? (
            <a
              href={vinculo.linkOriginal}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Abrir anexo original na fonte ${vinculo.nomeAnexo}`}
              className="grid size-6 shrink-0 place-items-center rounded-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          ) : null}
        </span>
        {vinculo.erro ? (
          <span className="mt-1 block max-w-[60ch] text-[12px] text-muted">
            {vinculo.erro}
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        <StatusPill state={descriptor.state} label={descriptor.label} />
      </TableCell>
      <TableCell className="text-right">
        <span className="inline-flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            aria-label={`Reprocessar anexo ${vinculo.nomeAnexo}`}
            title={podeReprocessar ? undefined : REPROCESSAR_BLOQUEIO_TITLE}
            disabled={!podeReprocessar || algumEmAndamento}
            onClick={onReprocessar}
          >
            {reprocessando ? "Reprocessando…" : "Reprocessar este anexo"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Ignorar anexo ${vinculo.nomeAnexo}`}
            title={podeIgnorar ? undefined : IGNORAR_BLOQUEIO_TITLE}
            disabled={!podeIgnorar || algumEmAndamento}
            onClick={onIgnorar}
          >
            {ignorando ? "Ignorando…" : "Ignorar este anexo"}
          </Button>
        </span>
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------
// Expansao do registro.
// ---------------------------------------------------------------------

export interface ColetaRegistroDetalheExpansionProps {
  /** Registro da linha mestra (cabecalho + avisoId + idComposto). */
  registro: RegistroColetado;
  /** id do painel (alvo do aria-controls do expansor da linha mestra). */
  panelId: string;
  /** Fecha a expansao (removendo o idComposto do conjunto expandido). */
  onClose: () => void;
}

export function ColetaRegistroDetalheExpansion({
  registro,
  panelId,
  onClose,
}: ColetaRegistroDetalheExpansionProps) {
  const { idComposto, cabecalho } = registro;
  const isEffecti = registro.fonte === "effecti";
  const objeto = registroObjeto(registro);

  const detalhe = useColetaRegistroDetalhe(idComposto);

  // Reindexar aviso (so Effecti). useReprocessar precisa do avisoId; quando
  // ausente passamos "" e o botao fica disabled — o hook nunca dispara.
  const reprocessarAviso = useReprocessar(registro.avisoId ?? "", idComposto);

  // Acoes granulares por vinculo (qualquer fonte).
  const reprocessarAnexo = useReprocessarAnexo();
  const ignorarAnexo = useIgnorarAnexo();

  const reprocessandoId =
    reprocessarAnexo.isPending && reprocessarAnexo.variables
      ? typeof reprocessarAnexo.variables === "string"
        ? reprocessarAnexo.variables
        : reprocessarAnexo.variables.id
      : undefined;
  const ignorandoId =
    ignorarAnexo.isPending && ignorarAnexo.variables
      ? typeof ignorarAnexo.variables === "string"
        ? ignorarAnexo.variables
        : ignorarAnexo.variables.id
      : undefined;

  // EC: detalhe 404 fecha a expansao (registro saiu do substrato).
  const is404 =
    detalhe.isError &&
    detalhe.error instanceof ApiError &&
    detalhe.error.status === 404;
  useEffect(() => {
    if (is404) onClose();
  }, [is404, onClose]);

  const vinculos = detalhe.data?.vinculos ?? [];
  const erros = detalhe.data?.erros ?? [];
  const execucaoOrigem = detalhe.data?.execucaoOrigem ?? null;

  return (
    <section
      id={panelId}
      aria-label={`Detalhe do registro ${objeto}`}
      className="flex flex-col gap-5 border-l-2 border-accent-line bg-surface-2 px-[18px] py-4"
    >
      {/* Cabecalho discriminado (instantaneo, da linha mestra). */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <CabecalhoDiscriminadoRenderer cabecalho={cabecalho} />
        {isEffecti ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            aria-label={`Reindexar aviso ${objeto}`}
            title={
              registro.avisoId
                ? undefined
                : "Aviso ainda nao disponivel para este registro"
            }
            disabled={!registro.avisoId || reprocessarAviso.isPending}
            onClick={() => reprocessarAviso.mutate()}
          >
            {reprocessarAviso.isPending ? "Reindexando…" : "Reindexar aviso"}
          </Button>
        ) : null}
      </div>

      {/* Vinculos por anexo. */}
      <div>
        <h4 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-soft">
          Anexos
        </h4>
        <Table aria-label={`Anexos do registro ${objeto}`}>
          <TableHeader>
            <TableRow>
              <TableHead>Anexo</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[1%] text-right">
                <span className="sr-only">Ações</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detalhe.isError && !is404 ? (
              <WorkbenchTableError
                title="Detalhe indisponível"
                message="Não foi possível carregar os anexos deste registro. Tente novamente."
                onRetry={() => detalhe.refetch()}
                colSpan={3}
              />
            ) : detalhe.isLoading ? (
              <WorkbenchSkeletonRows cols={3} rows={3} />
            ) : vinculos.length === 0 ? (
              <WorkbenchTableEmpty
                title="Nenhum anexo"
                description="Este registro não possui anexos vinculados."
                colSpan={3}
              />
            ) : (
              vinculos.map((vinculo) => (
                <VinculoRow
                  key={vinculo.id}
                  vinculo={vinculo}
                  reprocessando={reprocessandoId === vinculo.id}
                  ignorando={ignorandoId === vinculo.id}
                  onReprocessar={() =>
                    reprocessarAnexo.mutate({ id: vinculo.id, idComposto })
                  }
                  onIgnorar={() =>
                    ignorarAnexo.mutate({ id: vinculo.id, idComposto })
                  }
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Erros agregados (so quando ha). */}
      {erros.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-soft">
            Erros
          </h4>
          <ul className="flex flex-col gap-2">
            {erros.map((erro) => (
              <li
                key={erro.id}
                className="rounded-sm border border-border bg-surface px-3 py-2 text-[12.5px]"
              >
                <span className="flex flex-wrap items-center gap-2 text-muted">
                  <span className="font-semibold text-fg">{erro.etapa}</span>
                  <span>· {erro.severidade}</span>
                  <span>· {formatDateTime(erro.createdAt)}</span>
                </span>
                <span className="mt-1 block text-fg">{erro.mensagem}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Execucao de origem (so Effecti, quando presente). */}
      {isEffecti && execucaoOrigem ? (
        <div>
          <h4 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-soft">
            Execução de origem
          </h4>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Field label="Status" value={execucaoOrigem.status} />
            <Field label="Fonte" value={execucaoOrigem.fonte} />
            <Field
              label="Início"
              value={
                execucaoOrigem.iniciadaEm
                  ? formatDateTime(execucaoOrigem.iniciadaEm)
                  : null
              }
            />
            <Field
              label="Fim"
              value={
                execucaoOrigem.finalizadaEm
                  ? formatDateTime(execucaoOrigem.finalizadaEm)
                  : null
              }
            />
          </dl>
        </div>
      ) : null}
    </section>
  );
}
