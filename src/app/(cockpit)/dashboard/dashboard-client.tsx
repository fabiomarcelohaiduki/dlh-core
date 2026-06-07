"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  Clock,
  Database,
  TriangleAlert,
  ChevronRight,
  TrendingUp,
  Rocket,
} from "lucide-react";
import { useExecucoes, useErros, useHealthcheck } from "@/hooks/use-monitoring";
import { healthDescriptor, healthMeta } from "@/lib/status";
import { formatNumber, formatRelative, formatDateTime, formatGatilho } from "@/lib/format";
import { StatCard } from "@/components/cockpit/stat-card";
import { StatusPill } from "@/components/cockpit/status-pill";
import { RunsTable } from "@/components/cockpit/runs-table";
import { ErrosTable } from "@/components/cockpit/erros-table";
import { ColetaButton } from "@/components/cockpit/coleta-button";
import { WidgetError } from "@/components/cockpit/widget-error";

const DASH_RUNS_LIMIT = 6;

export function DashboardClient() {
  const router = useRouter();

  const health = useHealthcheck();
  const execucoes = useExecucoes({ limit: 50 });
  const erros = useErros();

  const healthData = health.data;
  const runs = execucoes.data?.items ?? [];
  const errosItems = erros.data?.items ?? [];

  const running = runs.some((r) => r.status === "em_andamento");

  // Estado empty global -> onboarding (1o acesso): nenhum dado em lugar nenhum.
  const allLoaded =
    health.isSuccess && execucoes.isSuccess && erros.isSuccess;
  const isOnboarding =
    allLoaded &&
    (healthData?.totalAvisos ?? 0) === 0 &&
    runs.length === 0 &&
    errosItems.length === 0;

  const healthState = healthData ? healthDescriptor(healthData.statusIngestao) : null;
  const healthMetaInfo = healthData ? healthMeta(healthData.statusIngestao) : null;
  const itensComErro = healthData?.itensComErro ?? 0;

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Dashboard</h2>
          <p>Saúde da ingestão e status das execuções de sincronização da fonte Effecti.</p>
        </div>
        <div className="actions">
          <ColetaButton variant="primary" blocked={running} />
        </div>
      </div>

      {isOnboarding && (
        <div className="banner">
          <Rocket aria-hidden="true" />
          <div>
            <b>Bem-vindo ao cockpit de ingestão</b>
            <p>
              Ainda não há dados no substrato. Configure a credencial e a frequência da fonte em{" "}
              <Link href="/fontes" className="link">
                Fontes e credenciais
              </Link>
              , ou dispare a primeira coleta agora.
            </p>
          </div>
        </div>
      )}

      {/* ---- KPIs (widget com error/empty proprios) ---- */}
      {health.isError ? (
        <WidgetError
          title="Healthcheck indisponível"
          message="Não foi possível ler a saúde da ingestão."
          onRetry={() => health.refetch()}
        />
      ) : (
        <div className="grid-dlh g4">
          <StatCard
            icon={<Activity aria-hidden="true" />}
            label="Status da ingestão"
            pill
            loading={health.isLoading}
            value={
              healthState ? (
                <StatusPill state={healthState.state} label={healthState.label} />
              ) : null
            }
            meta={healthMetaInfo?.text}
            metaTone={healthMetaInfo?.tone}
          />
          <StatCard
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
            icon={<Database aria-hidden="true" />}
            label="Avisos no substrato"
            loading={health.isLoading}
            value={
              <span className="tnum">
                {formatNumber(healthData?.totalAvisos)}
                <small>registros</small>
              </span>
            }
            meta={
              runs[0] && runs[0].novos > 0 ? (
                <>
                  <TrendingUp aria-hidden="true" />
                  {`+${runs[0].novos} na última coleta`}
                </>
              ) : (
                "Sem novos na última coleta"
              )
            }
            metaTone={runs[0] && runs[0].novos > 0 ? "up" : "default"}
          />
          <StatCard
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

      {/* ---- Execucoes recentes ---- */}
      <div className="section-title">
        <h3>Execuções recentes</h3>
        {!execucoes.isLoading && !execucoes.isError && (
          <span className="count">{runs.length}</span>
        )}
        <div className="right">
          <Link href="/execucoes" className="link">
            Ver todas
            <ChevronRight aria-hidden="true" />
          </Link>
        </div>
      </div>
      {execucoes.isError ? (
        <WidgetError
          title="Execuções indisponíveis"
          message="Não foi possível listar as execuções recentes."
          onRetry={() => execucoes.refetch()}
        />
      ) : (
        <RunsTable
          variant="dashboard"
          loading={execucoes.isLoading}
          runs={runs.slice(0, DASH_RUNS_LIMIT)}
          emptyTitle="Nenhuma execução ainda"
          emptyDescription="Dispare uma coleta sob demanda para iniciar a sincronização incremental."
          emptyAction={<ColetaButton blocked={running} />}
          onErroClick={() => router.push("/erros")}
        />
      )}

      {/* ---- Erros recentes ---- */}
      <div className="section-title">
        <h3>Erros recentes</h3>
        {!erros.isLoading && !erros.isError && (
          <span className="count">{errosItems.length}</span>
        )}
        <div className="right">
          <Link href="/erros" className="link">
            Abrir lista de erros
            <ChevronRight aria-hidden="true" />
          </Link>
        </div>
      </div>
      {erros.isError ? (
        <WidgetError
          title="Erros indisponíveis"
          message="Não foi possível listar os erros de ingestão."
          onRetry={() => erros.refetch()}
        />
      ) : (
        <ErrosTable
          variant="dashboard"
          loading={erros.isLoading}
          erros={errosItems.slice(0, 6)}
          emptyTitle="Nenhum erro recente"
          emptyDescription="A ingestão está saudável: coleta, tratamento e indexação sem falhas."
          onInvestigar={(avisoId) => router.push(`/edital/${avisoId}`)}
        />
      )}
    </section>
  );
}
