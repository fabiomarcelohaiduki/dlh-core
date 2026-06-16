"use client";

import Link from "next/link";
import {
  Activity,
  ChevronRight,
  Clock,
  Copy,
  Database,
  FileCheck,
  FileClock,
  FileWarning,
  HardDrive,
  Layers,
  Mail,
  Rocket,
  Server,
  TriangleAlert,
} from "lucide-react";
import type { QueryKey } from "@tanstack/react-query";
import {
  monitoringKeys,
  useExecucoes,
  useErros,
  useHealthcheck,
} from "@/hooks/use-monitoring";
import { fonteKeys, useFontes } from "@/hooks/use-fontes";
import { documentosKeys, useExtracaoResumo } from "@/hooks/use-documentos";
import { useExecucoesRealtime } from "@/hooks/use-execucoes-realtime";
import {
  conexaoDescriptor,
  healthDescriptor,
  healthMeta,
  type OrigemKey,
} from "@/lib/status";
import { formatNumber, formatRelative, formatDateTime, formatGatilho } from "@/lib/format";
import { StatCard } from "@/components/cockpit/stat-card";
import { StatusPill } from "@/components/cockpit/status-pill";
import { WidgetError } from "@/components/cockpit/widget-error";

type EstadoConexaoLike = Parameters<typeof conexaoDescriptor>[0];

/**
 * matchesOrigem — casa uma execucao com a fonte. Execucoes legadas (anteriores
 * ao schema multi-fonte) tem fonte_id null e, portanto, origem null; todas eram
 * do Effecti (1a fonte). O Nomus/Gmail/Drive sempre gravam fonte_id, entao
 * origem null conta como Effecti.
 */
function matchesOrigem(runOrigem: string | null, origem: OrigemKey): boolean {
  return runOrigem === origem || (origem === "effecti" && runOrigem === null);
}

/**
 * derivarSaude — saude de conexao por fonte para o card do Dashboard. Prioriza
 * a evidencia de coleta real: estado 'erro' explicito vence; senao, fonte com
 * dado no substrato ou com execucao concluida conta como "conectada"; por fim,
 * cai no estado_conexao bruto (ex.: "nao_configurada").
 */
function derivarSaude(
  estado: EstadoConexaoLike | undefined,
  runs: { origem: string | null; status: string }[],
  origem: OrigemKey,
  temDado: boolean,
): EstadoConexaoLike {
  if (estado === "erro") return "erro";
  const concluida = runs.some((r) => matchesOrigem(r.origem, origem) && r.status === "concluida");
  if (estado === "conectada" || temDado || concluida) return "conectada";
  return estado ?? "nao_configurada";
}

/** ultimaColeta — fim da ultima execucao concluida da fonte; fallback p/ fontes. */
function ultimaColeta(
  runs: { origem: string | null; fim: string | null }[],
  origem: OrigemKey,
  fallback: string | null,
): string | null {
  const finalizada = runs.find((r) => matchesOrigem(r.origem, origem) && r.fim);
  return finalizada?.fim ?? fallback;
}

/** Poll rapido enquanto ha coleta ativa; lento so quando o Realtime caiu. */
const RUNNING_POLL_MS = 3_000;
const FALLBACK_POLL_MS = 30_000;

/**
 * Keys refrescadas a cada evento de `execucoes` (heartbeat do substrato): KPIs,
 * lista, erros, fontes e extracao. Constante de modulo -> referencia estavel
 * para o array de dependencias do efeito do Realtime.
 */
const DASHBOARD_KEYS: QueryKey[] = [
  monitoringKeys.healthcheck,
  monitoringKeys.execucoesRoot,
  monitoringKeys.errosRoot,
  fonteKeys.all,
  documentosKeys.resumo,
];

/** Intervalo de fallback: poll rapido se coletando, senao so se desconectado. */
function pollWhile(running: boolean, connected: boolean): number | false {
  if (running) return RUNNING_POLL_MS;
  return connected ? false : FALLBACK_POLL_MS;
}

export function DashboardClient() {
  // Realtime: reusa o canal de `execucoes` (toda coleta/extracao roda como
  // execucao) como gatilho para refrescar todos os agregados do dashboard.
  const { connected } = useExecucoesRealtime({
    channelName: "dashboard-realtime",
    invalidateKeys: DASHBOARD_KEYS,
  });

  const execucoes = useExecucoes({
    limit: 50,
    // Rede de seguranca, independente do Realtime: poll rapido enquanto houver
    // coleta em andamento; parado, so faz poll lento se o Realtime caiu.
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      const ativo = items.some((r) => r.status === "em_andamento");
      return pollWhile(ativo, connected);
    },
  });

  // Mesmo fallback para os demais agregados (sem forma-funcao propria).
  const running = (execucoes.data?.items ?? []).some((r) => r.status === "em_andamento");
  const fallback = pollWhile(running, connected);

  const health = useHealthcheck({ refetchInterval: fallback });
  const erros = useErros(undefined, { refetchInterval: fallback });
  const fontes = useFontes({ refetchInterval: fallback });
  const extracao = useExtracaoResumo({ refetchInterval: fallback });

  const healthData = health.data;
  const runs = execucoes.data?.items ?? [];
  const errosItems = erros.data?.items ?? [];
  const contagens = extracao.data?.contagens;

  const totalAvisos = healthData?.totalAvisos ?? 0;
  const totalProcessos = healthData?.totalProcessos ?? 0;
  const totalPessoas = healthData?.totalPessoas ?? 0;
  const itensComErro = healthData?.itensComErro ?? 0;
  const totalSubstrato = totalAvisos + totalProcessos + totalPessoas;

  // Status geral do pipeline (vw_healthcheck) -> hero do topo.
  const statusIngestao = healthData?.statusIngestao ?? "Falha";
  const statusPill = healthDescriptor(statusIngestao);
  const statusMetaInfo = healthMeta(statusIngestao);

  // Saude por fonte. O pill de conexao (public.fontes.estado_conexao) so e
  // carimbado pelo teste manual / coleta do Nomus, entao o pipeline das demais
  // fontes o deixa em "nao_configurada" mesmo coletando. Para refletir a coleta
  // real, derivamos a saude e a "ultima coleta" da ultima execucao da fonte
  // (origem + fim), com fallback para o estado/timestamp de public.fontes.
  const fonteCards: {
    tipo: OrigemKey;
    label: string;
    icon: React.ReactNode;
    temDado: boolean;
    metaPrefixo: string | null;
  }[] = [
    {
      tipo: "effecti",
      label: "Effecti",
      icon: <Database aria-hidden="true" />,
      temDado: totalAvisos > 0,
      metaPrefixo: `${formatNumber(totalAvisos)} avisos`,
    },
    {
      tipo: "nomus",
      label: "Nomus",
      icon: <Server aria-hidden="true" />,
      temDado: totalProcessos > 0 || totalPessoas > 0,
      metaPrefixo: `${formatNumber(totalProcessos)} processos · ${formatNumber(totalPessoas)} pessoas`,
    },
    {
      tipo: "gmail",
      label: "Gmail",
      icon: <Mail aria-hidden="true" />,
      temDado: false,
      metaPrefixo: null,
    },
    {
      tipo: "drive",
      label: "Drive",
      icon: <HardDrive aria-hidden="true" />,
      temDado: false,
      metaPrefixo: null,
    },
  ];

  // Estado empty global -> onboarding (1o acesso): nenhum dado em fonte alguma.
  const allLoaded =
    health.isSuccess &&
    execucoes.isSuccess &&
    erros.isSuccess &&
    fontes.isSuccess;
  const isOnboarding =
    allLoaded &&
    totalAvisos === 0 &&
    totalProcessos === 0 &&
    totalPessoas === 0 &&
    runs.length === 0 &&
    errosItems.length === 0;

  return (
    <section className="screen">
      {/* ---- Cabecalho editorial: identidade da tela + status-resumo ---- */}
      <header className="dash-head">
        <div className="titles">
          <p className="eyebrow">Cockpit de ingestão</p>
          <h2>Visão geral da operação</h2>
          <p className="lede">
            Saúde do pipeline, substrato coletado e estado das fontes em um só lugar.
          </p>
        </div>
        {!health.isError && (
          <div className="head-status">
            {health.isLoading ? (
              <span className="skel skel-pill" />
            ) : (
              <StatusPill state={statusPill.state} label={statusPill.label} />
            )}
            <span className="stamp">
              <Clock aria-hidden="true" />
              Sincronizado {formatRelative(healthData?.ultimaSync)}
            </span>
          </div>
        )}
      </header>

      {isOnboarding && (
        <div className="banner">
          <Rocket aria-hidden="true" />
          <div>
            <b>Bem-vindo ao cockpit de ingestão</b>
            <p>
              Ainda não há dados no substrato. Configure a credencial e a frequência das fontes em{" "}
              <Link href="/ingestao/fontes" className="link">
                Fontes e credenciais
              </Link>{" "}
              para iniciar a primeira coleta.
            </p>
          </div>
        </div>
      )}

      {/* ---- KPIs globais: status, substrato, ultima sync, erros ---- */}
      {health.isError ? (
        <WidgetError
          title="Indicadores indisponíveis"
          message="Não foi possível ler a saúde da ingestão."
          onRetry={() => health.refetch()}
        />
      ) : (
        <div className="grid-dlh g4 stat-rise">
          <StatCard
            index={0}
            icon={<Activity aria-hidden="true" />}
            label="Status da ingestão"
            pill
            loading={health.isLoading}
            value={<StatusPill state={statusPill.state} label={statusPill.label} />}
            meta={statusMetaInfo.text}
            metaTone={statusMetaInfo.tone}
          />
          <StatCard
            index={1}
            icon={<Layers aria-hidden="true" />}
            label="Substrato"
            loading={health.isLoading}
            value={formatNumber(totalSubstrato)}
            meta={`${formatNumber(totalAvisos)} avisos · ${formatNumber(totalProcessos)} processos · ${formatNumber(totalPessoas)} pessoas`}
          />
          <StatCard
            index={2}
            icon={<Clock aria-hidden="true" />}
            label="Última sincronização"
            loading={health.isLoading}
            value={formatRelative(healthData?.ultimaSync)}
            meta={
              runs[0]
                ? `${formatGatilho(runs[0].gatilho)} · ${formatDateTime(runs[0].inicio)}`
                : "Sem coletas registradas"
            }
          />
          <StatCard
            index={3}
            icon={<TriangleAlert aria-hidden="true" />}
            label="Itens com erro"
            loading={health.isLoading}
            value={
              <span
                className="tnum"
                style={{ color: itensComErro > 0 ? "var(--err)" : undefined }}
              >
                {formatNumber(itensComErro)}
              </span>
            }
            meta={
              itensComErro > 0
                ? "Verifique a lista de erros de ingestão"
                : "Pipeline sem itens em erro"
            }
            metaTone={itensComErro > 0 ? "warn" : "up"}
          />
        </div>
      )}

      {/* ---- Fontes conectadas (saude por fonte) ---- */}
      <div className="section-title">
        <h3>Fontes conectadas</h3>
        <div className="right">
          <Link href="/ingestao/fontes" className="link">
            Gerenciar fontes
            <ChevronRight aria-hidden="true" />
          </Link>
        </div>
      </div>
      {fontes.isError ? (
        <WidgetError
          title="Fontes indisponíveis"
          message="Não foi possível ler a saúde das fontes."
          onRetry={() => fontes.refetch()}
        />
      ) : (
        <div className="grid-dlh g4 stat-rise">
          {fonteCards.map((fc, i) => {
            const fonte = fontes.data?.find((f) => f.tipo === fc.tipo);
            const saude = derivarSaude(fonte?.estadoConexao, runs, fc.tipo, fc.temDado);
            const pill = conexaoDescriptor(saude);
            const coleta = ultimaColeta(runs, fc.tipo, fonte?.ultimaColetaEm ?? null);
            const metaColeta = `coleta ${formatRelative(coleta)}`;
            return (
              <StatCard
                key={fc.tipo}
                index={i}
                icon={fc.icon}
                label={fc.label}
                pill
                loading={fontes.isLoading || health.isLoading}
                value={<StatusPill state={pill.state} label={pill.label} />}
                meta={fc.metaPrefixo ? `${fc.metaPrefixo} · ${metaColeta}` : metaColeta}
              />
            );
          })}
        </div>
      )}

      {/* ---- Pipeline de extração (camada 1: documentos) ---- */}
      <div className="section-title">
        <h3>Pipeline de extração</h3>
        <div className="right">
          <Link href="/ingestao/extracao" className="link">
            Abrir extração
            <ChevronRight aria-hidden="true" />
          </Link>
        </div>
      </div>
      {extracao.isError ? (
        <WidgetError
          title="Extração indisponível"
          message="Não foi possível ler o resumo do pipeline de extração."
          onRetry={() => extracao.refetch()}
        />
      ) : (
        <div className="grid-dlh g4 stat-rise">
          <StatCard
            index={0}
            icon={<FileClock aria-hidden="true" />}
            label="Pendentes"
            loading={extracao.isLoading}
            value={formatNumber(contagens?.pendente ?? 0)}
            meta="Anexos na fila de extração"
          />
          <StatCard
            index={1}
            icon={<FileCheck aria-hidden="true" />}
            label="Extraídos"
            loading={extracao.isLoading}
            value={formatNumber(contagens?.extraido ?? 0)}
            meta="Texto extraído com sucesso"
            metaTone="up"
          />
          <StatCard
            index={2}
            icon={<Copy aria-hidden="true" />}
            label="Herdados"
            loading={extracao.isLoading}
            value={formatNumber(contagens?.herdado ?? 0)}
            meta="Reaproveitados por dedup"
          />
          <StatCard
            index={3}
            icon={<FileWarning aria-hidden="true" />}
            label="Falhas"
            loading={extracao.isLoading}
            value={
              <span
                className="tnum"
                style={{ color: (contagens?.erro ?? 0) > 0 ? "var(--err)" : undefined }}
              >
                {formatNumber(contagens?.erro ?? 0)}
              </span>
            }
            meta={
              (contagens?.erro ?? 0) > 0
                ? "Anexos que falharam na extração"
                : "Nenhuma falha de extração"
            }
            metaTone={(contagens?.erro ?? 0) > 0 ? "warn" : "up"}
          />
        </div>
      )}
    </section>
  );
}
