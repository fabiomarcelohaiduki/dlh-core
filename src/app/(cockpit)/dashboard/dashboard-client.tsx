"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Clock,
  Database,
  Server,
  TriangleAlert,
  ChevronRight,
  Rocket,
} from "lucide-react";
import { useExecucoes, useErros, useHealthcheck } from "@/hooks/use-monitoring";
import { useFontes } from "@/hooks/use-fontes";
import { conexaoDescriptor } from "@/lib/status";
import { formatNumber, formatRelative, formatDateTime, formatGatilho } from "@/lib/format";
import { StatCard } from "@/components/cockpit/stat-card";
import { StatusPill } from "@/components/cockpit/status-pill";
import { RunsTable } from "@/components/cockpit/runs-table";
import { ErrosTable } from "@/components/cockpit/erros-table";
import { ColetaButton } from "@/components/cockpit/coleta-button";
import { WidgetError } from "@/components/cockpit/widget-error";

const DASH_RUNS_LIMIT = 6;

type Origem = "effecti" | "nomus";
type EstadoConexaoLike = Parameters<typeof conexaoDescriptor>[0];

/**
 * matchesOrigem — casa uma execucao com a fonte. Execucoes legadas (anteriores
 * ao schema multi-fonte) tem fonte_id null e, portanto, origem null; todas eram
 * do Effecti (1a fonte). O Nomus sempre grava fonte_id, entao origem null conta
 * como Effecti.
 */
function matchesOrigem(runOrigem: string | null, origem: Origem): boolean {
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
  origem: Origem,
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
  origem: Origem,
  fallback: string | null,
): string | null {
  const finalizada = runs.find((r) => matchesOrigem(r.origem, origem) && r.fim);
  return finalizada?.fim ?? fallback;
}

export function DashboardClient() {
  const router = useRouter();

  const health = useHealthcheck();
  const execucoes = useExecucoes({ limit: 50 });
  const erros = useErros();
  const fontes = useFontes();

  const healthData = health.data;
  const runs = execucoes.data?.items ?? [];
  const errosItems = erros.data?.items ?? [];

  const running = runs.some((r) => r.status === "em_andamento");

  const totalAvisos = healthData?.totalAvisos ?? 0;
  const totalProcessos = healthData?.totalProcessos ?? 0;
  const itensComErro = healthData?.itensComErro ?? 0;

  // Saude por fonte. O pill de conexao (public.fontes.estado_conexao) so e
  // carimbado pelo teste manual / coleta do Nomus, entao o pipeline do Effecti
  // o deixa em "nao_configurada" mesmo coletando. Para refletir a coleta real,
  // derivamos a saude e a "ultima coleta" da ultima execucao da fonte (origem +
  // fim), com fallback para o estado/timestamp de public.fontes.
  const effecti = fontes.data?.find((f) => f.tipo === "effecti");
  const nomus = fontes.data?.find((f) => f.tipo === "nomus");

  const effectiSaude = derivarSaude(effecti?.estadoConexao, runs, "effecti", totalAvisos > 0);
  const nomusSaude = derivarSaude(nomus?.estadoConexao, runs, "nomus", totalProcessos > 0);
  const effectiPill = conexaoDescriptor(effectiSaude);
  const nomusPill = conexaoDescriptor(nomusSaude);
  const effectiColeta = ultimaColeta(runs, "effecti", effecti?.ultimaColetaEm ?? null);
  const nomusColeta = ultimaColeta(runs, "nomus", nomus?.ultimaColetaEm ?? null);

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
    runs.length === 0 &&
    errosItems.length === 0;

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Dashboard</h2>
          <p>Saúde da ingestão e status das execuções de sincronização das fontes conectadas.</p>
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
              Ainda não há dados no substrato. Configure a credencial e a frequência das fontes em{" "}
              <Link href="/fontes" className="link">
                Fontes e credenciais
              </Link>
              , ou dispare a primeira coleta agora.
            </p>
          </div>
        </div>
      )}

      {/* ---- KPIs: saude por fonte + erros (widget com error/empty proprios) ---- */}
      {health.isError || fontes.isError ? (
        <WidgetError
          title="Indicadores indisponíveis"
          message="Não foi possível ler a saúde das fontes."
          onRetry={() => {
            health.refetch();
            fontes.refetch();
          }}
        />
      ) : (
        <div className="grid-dlh g4">
          <StatCard
            icon={<Database aria-hidden="true" />}
            label="Effecti · avisos"
            pill
            loading={fontes.isLoading || health.isLoading}
            value={<StatusPill state={effectiPill.state} label={effectiPill.label} />}
            meta={`${formatNumber(totalAvisos)} avisos · coleta ${formatRelative(effectiColeta)}`}
          />
          <StatCard
            icon={<Server aria-hidden="true" />}
            label="Nomus · processos"
            pill
            loading={fontes.isLoading || health.isLoading}
            value={<StatusPill state={nomusPill.state} label={nomusPill.label} />}
            meta={`${formatNumber(totalProcessos)} processos · coleta ${formatRelative(nomusColeta)}`}
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
