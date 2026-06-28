"use client";

// =====================================================================
// env-settings-form — 7 paineis REAIS da Configuração geral (Design Lock).
//
// Persistência AO VIVO (princípio do produto, persona Roberto): NÃO há botão
// "Salvar". Cada alteração de controle dispara um PATCH imediato via
// `usePatchConfiguracao` e exibe um toast efêmero de sucesso/erro. Linhas
// dependentes ficam `is-muted` + disabled quando a linha-mãe está desligada.
// Validação de entrada com zod nos campos com enum/intervalo.
// =====================================================================

import { useEffect, useState } from "react";
import { z } from "zod";
import { Check, TriangleAlert } from "lucide-react";
import { useConfiguracao, usePatchConfiguracao } from "@/hooks/use-configuracao";
import { refreshCockpit } from "@/lib/cockpit/cockpit-engines";
import type { Configuracao } from "@/types/domain";
import { CcRow } from "./cc-row";
import { CcToggle } from "./cc-toggle";
import { CcSeg, type CcSegOption } from "./cc-seg";
import { CcSelect, type CcSelectOption } from "./cc-select";
import { ThemePicker, useTemaAtivoLabel } from "./theme-picker";
import { CfgAccordion } from "./cfg-accordion";

// ---------------------------------------------------------------------
// Opções dos controles
// ---------------------------------------------------------------------

const DENSIDADE_OPTS: ReadonlyArray<CcSegOption<Configuracao["densidade"]>> = [
  { value: "compacta", label: "Compacta" },
  { value: "padrao", label: "Padrão" },
  { value: "confortavel", label: "Confortável" },
];

type AreaValue = "cockpit" | "atividade_global" | "configuracao_geral";
const AREA_OPTS: ReadonlyArray<CcSelectOption<AreaValue>> = [
  { value: "cockpit", label: "Cockpit" },
  { value: "atividade_global", label: "Atividade global" },
  { value: "configuracao_geral", label: "Configuração geral" },
];

type TzValue = "-03:00" | "-04:00" | "-05:00" | "-02:00";
const TZ_OPTS: ReadonlyArray<CcSelectOption<TzValue>> = [
  { value: "-03:00", label: "Brasília (UTC−03:00)" },
  { value: "-04:00", label: "Amazônia (UTC−04:00)" },
  { value: "-05:00", label: "Acre (UTC−05:00)" },
  { value: "-02:00", label: "Fernando de Noronha (UTC−02:00)" },
];

type DateFmtValue = "dmy" | "dmy-dot" | "iso";
const DATE_FMT_OPTS: ReadonlyArray<CcSelectOption<DateFmtValue>> = [
  { value: "dmy", label: "31/12/2026" },
  { value: "dmy-dot", label: "31.12.2026" },
  { value: "iso", label: "2026-12-31" },
];

type NumFmtValue = "pt" | "en";
const NUM_FMT_OPTS: ReadonlyArray<CcSelectOption<NumFmtValue>> = [
  { value: "pt", label: "1.234,56" },
  { value: "en", label: "1,234.56" },
];

type SyncFreqValue = "5" | "15" | "30" | "60";
const SYNC_FREQ_OPTS: ReadonlyArray<CcSelectOption<SyncFreqValue>> = [
  { value: "5", label: "A cada 5 minutos" },
  { value: "15", label: "A cada 15 minutos" },
  { value: "30", label: "A cada 30 minutos" },
  { value: "60", label: "A cada 1 hora" },
];

type TimeoutValue = "0" | "15" | "30" | "60" | "240";
const TIMEOUT_OPTS: ReadonlyArray<CcSelectOption<TimeoutValue>> = [
  { value: "0", label: "Nunca expira" },
  { value: "15", label: "15 minutos" },
  { value: "30", label: "30 minutos" },
  { value: "60", label: "1 hora" },
  { value: "240", label: "4 horas" },
];

// ---------------------------------------------------------------------
// Validação zod (enum/intervalo) — patch parcial
// ---------------------------------------------------------------------

const configPatchSchema = z
  .object({
    densidade: z.enum(["compacta", "padrao", "confortavel"]),
    defaultArea: z.enum(["cockpit", "atividade_global", "configuracao_geral"]),
    highlightPendencias: z.boolean(),
    tz: z.enum(["-03:00", "-04:00", "-05:00", "-02:00"]),
    dateFmt: z.enum(["dmy", "dmy-dot", "iso"]),
    numFmt: z.enum(["pt", "en"]),
    notifyAlerts: z.boolean(),
    notifyIngest: z.boolean(),
    notifyDeadline: z.boolean(),
    notifyDigest: z.boolean(),
    autoSync: z.boolean(),
    syncFreq: z
      .number()
      .int()
      .refine((v) => [5, 15, 30, 60].includes(v), "Frequência inválida"),
    sessionTimeout: z
      .number()
      .int()
      .refine((v) => [0, 15, 30, 60, 240].includes(v), "Tempo inválido"),
    sessionWarn: z.boolean(),
    reduzirMovimento: z.boolean(),
  })
  .partial();

type Toast = { kind: "ok" | "err"; message: string };

// ---------------------------------------------------------------------
// Prévias derivadas (puras, deterministas — sem `new Date()` para não causar
// mismatch de hidratação SSR)
// ---------------------------------------------------------------------

const TZ_LABEL: Record<TzValue, string> = {
  "-03:00": "UTC\u221203:00",
  "-04:00": "UTC\u221204:00",
  "-05:00": "UTC\u221205:00",
  "-02:00": "UTC\u221202:00",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * renderLocalePreview — prévia real de prazo e valor segundo fuso, formato de
 * data e formato de número escolhidos. Usa uma amostra fixa (31/12/2026 17:30 e
 * 1.234.567,89) para ser determinista entre servidor e cliente.
 */
function renderLocalePreview(
  dateFmt: DateFmtValue,
  numFmt: NumFmtValue,
  tz: TzValue,
): { prazo: string; valor: string } {
  const y = 2026;
  const mo = 12;
  const d = 31;
  const data =
    dateFmt === "iso"
      ? `${y}-${pad2(mo)}-${pad2(d)}`
      : dateFmt === "dmy-dot"
        ? `${pad2(d)}.${pad2(mo)}.${y}`
        : `${pad2(d)}/${pad2(mo)}/${y}`;
  const prazo = `${data} 17:30 ${TZ_LABEL[tz]}`;

  const sample = 1234567.89;
  const valor = sample.toLocaleString(numFmt === "pt" ? "pt-BR" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return { prazo, valor };
}

/** Formata segundos restantes como m:ss para a contagem regressiva do sync. */
function fmtCountdown(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${pad2(s)}`;
}

// ---------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------

export function EnvSettingsForm() {
  const { data: cfg, isLoading } = useConfiguracao();
  const patch = usePatchConfiguracao();
  const temaLabel = useTemaAtivoLabel();
  const [toast, setToast] = useState<Toast | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  // Auto-dismiss do toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // Sincronização automática: contagem regressiva ao vivo (#envSyncPreview) e,
  // ao zerar, reroda `refreshCockpit()` (releitura read-only silenciosa) e
  // reinicia o ciclo. Desligado o auto-sync, não há timer.
  const autoSync = cfg?.autoSync ?? false;
  const syncFreq = cfg?.syncFreq ?? 15;
  useEffect(() => {
    if (!autoSync || !syncFreq) {
      setRemaining(null);
      return;
    }
    const total = syncFreq * 60;
    setRemaining(total);
    const id = setInterval(() => {
      setRemaining((prev) => {
        if (prev === null) return prev;
        if (prev <= 1) {
          refreshCockpit();
          return total;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [autoSync, syncFreq]);

  /** Persistência ao vivo: valida o patch (zod) e dispara a mutation + toast. */
  function commit(p: Partial<Configuracao>) {
    const parsed = configPatchSchema.safeParse(p);
    if (!parsed.success) {
      setToast({ kind: "err", message: "Valor inválido. Nada foi alterado." });
      return;
    }
    patch.mutate(parsed.data as Partial<Configuracao>, {
      onSuccess: () => setToast({ kind: "ok", message: "Preferência salva." }),
      onError: () =>
        setToast({
          kind: "err",
          message: "Não foi possível salvar. Tente novamente.",
        }),
    });
  }

  if (isLoading || !cfg) {
    return (
      <section className="config-geral-view" aria-busy={isLoading}>
        <div className="cfg-panel-card">
          <div className="panel-header">
            <div className="panel-title">
              <h3>Configuração geral</h3>
              <p>Carregando preferências do ambiente…</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Estados derivados para linhas dependentes (is-muted/disabled).
  const notifyOff = !cfg.notifyAlerts;
  const syncOff = !cfg.autoSync;
  const sessaoNuncaExpira = cfg.sessionTimeout === 0;

  const defaultArea = (cfg.defaultArea ?? "cockpit") as AreaValue;
  const preview = renderLocalePreview(
    cfg.dateFmt as DateFmtValue,
    cfg.numFmt as NumFmtValue,
    cfg.tz as TzValue,
  );

  return (
    <section className="config-geral-view">
      <CfgAccordion>
      {/* 1 — Densidade / área inicial */}
      <section className="cfg-panel-card" aria-labelledby="cfg-geral">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="cfg-geral">Configuração geral</h3>
            <p>Preferências de todo o ambiente aplicadas ao cockpit e módulos.</p>
          </div>
          <span className="pill">Ambiente local</span>
        </div>
        <div className="cc-mod">
          <CcRow
            title="Área inicial"
            description="Tela que abre logo após o login."
            controls={
              <CcSelect
                id="envDefaultArea"
                ariaLabel="Tela inicial após o login"
                value={defaultArea}
                options={AREA_OPTS}
                onChange={(v) => commit({ defaultArea: v })}
              />
            }
          />
          <CcRow
            title="Densidade"
            description="Espaçamento de linhas e cards na leitura operacional."
            controls={
              <CcSeg
                id="envDensity"
                ariaLabel="Densidade da interface"
                value={cfg.densidade}
                options={DENSIDADE_OPTS}
                onChange={(v) => commit({ densidade: v })}
              />
            }
          />
          <CcRow
            title="Destacar pendências"
            description="Dá contorno e peso aos estados pendentes em todo o ambiente."
            controls={
              <CcToggle
                id="envHighlightPending"
                ariaLabel="Destacar pendências"
                checked={cfg.highlightPendencias}
                onChange={(v) => commit({ highlightPendencias: v })}
              />
            }
          />
        </div>
      </section>

      {/* 2 — Idioma & região */}
      <section className="cfg-panel-card" aria-labelledby="cfg-regiao">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="cfg-regiao">Idioma &amp; região</h3>
            <p>Fuso, data e número usados para ler prazos em todo o ambiente.</p>
          </div>
          <span className="pill">Brasil</span>
        </div>
        <div className="cc-mod">
          <CcRow
            title="Fuso horário"
            description="Base para horários de ingestão e contagem de prazos."
            controls={
              <CcSelect
                id="envTz"
                ariaLabel="Fuso horário"
                value={cfg.tz as TzValue}
                options={TZ_OPTS}
                onChange={(v) => commit({ tz: v })}
              />
            }
          />
          <CcRow
            title="Formato de data"
            description="Como datas e prazos são exibidos."
            controls={
              <CcSelect
                id="envDateFmt"
                ariaLabel="Formato de data"
                value={cfg.dateFmt as DateFmtValue}
                options={DATE_FMT_OPTS}
                onChange={(v) => commit({ dateFmt: v })}
              />
            }
          />
          <CcRow
            title="Formato de número"
            description="Separador de milhar e decimal."
            controls={
              <CcSelect
                id="envNumFmt"
                ariaLabel="Formato de número"
                value={cfg.numFmt as NumFmtValue}
                options={NUM_FMT_OPTS}
                onChange={(v) => commit({ numFmt: v })}
              />
            }
          />
        </div>
        <p className="cc-preview" id="envLocalePreview">
          Prévia — prazo: <strong>{preview.prazo}</strong> · valor:{" "}
          <strong>{preview.valor}</strong>
        </p>
      </section>

      {/* 3 — Notificações do ambiente */}
      <section className="cfg-panel-card" aria-labelledby="cfg-notif">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="cfg-notif">Notificações do ambiente</h3>
            <p>Quais sinais operacionais o cockpit destaca.</p>
          </div>
          <span
            id="notifyStatusPill"
            className={cfg.notifyAlerts ? "pill ok" : "pill idle"}
          >
            {cfg.notifyAlerts ? "Alertas ativos" : "Alertas em silêncio"}
          </span>
        </div>
        <div className="cc-mod">
          <CcRow
            title="Indicador de alerta na topbar"
            description="Mostra o ponto de alerta no ícone de atividade quando há sinais pendentes."
            controls={
              <CcToggle
                id="notifyAlerts"
                ariaLabel="Indicador de alerta na topbar"
                checked={cfg.notifyAlerts}
                onChange={(v) => commit({ notifyAlerts: v })}
              />
            }
          />
          <CcRow
            sub
            muted={notifyOff}
            title="Falha de ingestão"
            description="Sinaliza quando o processamento de um documento não conclui."
            controls={
              <CcToggle
                id="notifyIngest"
                ariaLabel="Falha de ingestão"
                checked={cfg.notifyIngest}
                disabled={notifyOff}
                onChange={(v) => commit({ notifyIngest: v })}
              />
            }
          />
          <CcRow
            sub
            muted={notifyOff}
            title="Prazo se aproximando"
            description="Destaca registros com prazo dentro dos próximos dias."
            controls={
              <CcToggle
                id="notifyDeadline"
                ariaLabel="Prazo se aproximando"
                checked={cfg.notifyDeadline}
                disabled={notifyOff}
                onChange={(v) => commit({ notifyDeadline: v })}
              />
            }
          />
          <CcRow
            sub
            muted={notifyOff}
            title="Resumo diário"
            description="Consolida a atividade do dia em um único aviso."
            controls={
              <CcToggle
                id="notifyDigest"
                ariaLabel="Resumo diário"
                checked={cfg.notifyDigest}
                disabled={notifyOff}
                onChange={(v) => commit({ notifyDigest: v })}
              />
            }
          />
        </div>
      </section>

      {/* 4 — Sincronização do ambiente */}
      <section className="cfg-panel-card" aria-labelledby="cfg-sync">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="cfg-sync">Sincronização do ambiente</h3>
            <p>Como o cockpit reconsolida a leitura.</p>
          </div>
          <span
            id="syncSchedulePill"
            className={cfg.autoSync ? "pill ok" : "pill idle"}
          >
            {cfg.autoSync ? `A cada ${cfg.syncFreq} min` : "Manual"}
          </span>
        </div>
        <div className="cc-mod">
          <CcRow
            title="Atualização automática"
            description="Reconsolida o cockpit em intervalo fixo, sem precisar do botão."
            controls={
              <CcToggle
                id="envAutoSync"
                ariaLabel="Atualização automática"
                checked={cfg.autoSync}
                onChange={(v) => commit({ autoSync: v })}
              />
            }
          />
          <CcRow
            sub
            muted={syncOff}
            title="Frequência"
            description="De quanto em quanto tempo a leitura é refeita."
            controls={
              <CcSelect
                id="envSyncFreq"
                ariaLabel="Frequência de atualização"
                value={String(cfg.syncFreq) as SyncFreqValue}
                options={SYNC_FREQ_OPTS}
                disabled={syncOff}
                onChange={(v) => commit({ syncFreq: Number(v) })}
              />
            }
          />
        </div>
        <p className="cc-preview" id="envSyncPreview">
          {cfg.autoSync ? (
            <>
              Reconsolidação automática a cada{" "}
              <strong>{cfg.syncFreq} minutos</strong>
              {remaining !== null ? (
                <>
                  {" "}
                  · próxima em <strong>{fmtCountdown(remaining)}</strong>
                </>
              ) : null}
              .
            </>
          ) : (
            <>
              Sincronização sob demanda pelo botão <strong>Cockpit</strong>.
            </>
          )}
        </p>
      </section>

      {/* 5 — Sessão */}
      <section className="cfg-panel-card" aria-labelledby="cfg-sessao">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="cfg-sessao">Sessão</h3>
            <p>Encerramento automático por inatividade desta sessão local.</p>
          </div>
          <span id="sessionStatusPill" className="pill idle">
            {sessaoNuncaExpira
              ? "Sem expiração"
              : `Expira em ${cfg.sessionTimeout} min`}
          </span>
        </div>
        <div className="cc-mod">
          <CcRow
            title="Expiração por inatividade"
            description="Tempo sem interação até a sessão ser encerrada."
            controls={
              <CcSelect
                id="envSessionTimeout"
                ariaLabel="Expiração por inatividade"
                value={String(cfg.sessionTimeout) as TimeoutValue}
                options={TIMEOUT_OPTS}
                onChange={(v) => commit({ sessionTimeout: Number(v) })}
              />
            }
          />
          <CcRow
            sub
            muted={sessaoNuncaExpira}
            title="Aviso antes de encerrar"
            description="Mostra um aviso um minuto antes de fechar a sessão."
            controls={
              <CcToggle
                id="envSessionWarn"
                ariaLabel="Aviso antes de encerrar"
                checked={cfg.sessionWarn}
                disabled={sessaoNuncaExpira}
                onChange={(v) => commit({ sessionWarn: v })}
              />
            }
          />
        </div>
        <p className="cc-preview" id="envSessionPreview">
          {sessaoNuncaExpira ? (
            <>A sessão permanece aberta até a saída manual.</>
          ) : (
            <>
              A sessão encerra após <strong>{cfg.sessionTimeout} minutos</strong>{" "}
              de inatividade. Qualquer interação reinicia a contagem.
            </>
          )}
        </p>
      </section>

      {/* 6 — Acessibilidade */}
      <section className="cfg-panel-card" aria-labelledby="cfg-acess">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="cfg-acess">Acessibilidade</h3>
            <p>Preferências de leitura aplicadas em toda a interface autenticada.</p>
          </div>
          <span id="motionStatusPill" className="pill idle">
            {cfg.reduzirMovimento ? "Movimento reduzido" : "Padrão"}
          </span>
        </div>
        <div className="cc-mod">
          <CcRow
            title="Reduzir movimento"
            description="Desliga animações e transições de painéis, toasts e tabelas."
            controls={
              <CcToggle
                id="envReduceMotion"
                ariaLabel="Reduzir movimento"
                checked={cfg.reduzirMovimento}
                onChange={(v) => commit({ reduzirMovimento: v })}
              />
            }
          />
        </div>
      </section>

      {/* 7 — Aparência (theme-picker) */}
      <section className="cfg-panel-card" aria-labelledby="cfg-aparencia">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="cfg-aparencia">Aparência</h3>
            <p>Tema visual aplicado em toda a interface autenticada, incluindo a tela de login.</p>
          </div>
          <span className="pill ok" id="activeThemeName">
            {temaLabel}
          </span>
        </div>
        <ThemePicker
          onAplicado={() => setToast({ kind: "ok", message: "Tema aplicado." })}
          onErro={() =>
            setToast({
              kind: "err",
              message: "Não foi possível trocar o tema. Revertido.",
            })
          }
        />
      </section>
      </CfgAccordion>

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className={`cfg-toast ${toast.kind === "err" ? "is-err" : "is-ok"}`}
        >
          {toast.kind === "err" ? (
            <TriangleAlert aria-hidden="true" width={16} height={16} />
          ) : (
            <Check aria-hidden="true" width={16} height={16} />
          )}
          {toast.message}
        </div>
      ) : null}
    </section>
  );
}
