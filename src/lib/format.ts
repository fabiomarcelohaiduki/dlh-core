// =====================================================================
// Helpers de formatacao para o cockpit. Sem libs externas: usa Intl nativo.
// Convencoes visuais alinhadas ao Design Lock (datas curtas, tnum).
// =====================================================================

const DATE_TIME = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const DATE_TIME_FULL = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// A abertura dos lances (data_final do aviso Effecti) e gravada em UTC real
// (o horario de Brasilia do edital foi convertido com offset -03:00 na ingestao,
// ex: 08:00 BRT -> 11:00Z). Por isso data e hora sao formatadas no fuso de
// Brasilia, devolvendo o horario que a licitacao realmente abre (08:00).
const DATA_BR = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "America/Sao_Paulo",
});

const HORA_BR = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Sao_Paulo",
});

const NUMBER = new Intl.NumberFormat("pt-BR");

const CURRENCY = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "05/06 14:12" — usado nas tabelas de execucoes/erros. */
export function formatDateTime(value: string | null | undefined): string {
  const d = parse(value);
  return d ? DATE_TIME.format(d).replace(",", "") : "—";
}

/** "05/06/2025 · 14:12:08" — detalhe. */
export function formatDateTimeFull(value: string | null | undefined): string {
  const d = parse(value);
  if (!d) return "—";
  return DATE_TIME_FULL.format(d).replace(",", " ·");
}

/**
 * "01/06/2025" — datas de vigencia (sem hora). Trata o caso comum de datas
 * "YYYY-MM-DD" sem fuso (vigencia de precos/custos) reformatando os componentes
 * diretamente, evitando o deslize de um dia que `new Date('YYYY-MM-DD')`
 * causaria por interpretar como meia-noite UTC.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const d = parse(value);
  return d ? d.toLocaleDateString("pt-BR") : "—";
}

/** "22/06/2026" — data de abertura dos lances (data_final), no fuso de Brasilia. */
export function formatDataBr(value: string | null | undefined): string {
  const d = parse(value);
  return d ? DATA_BR.format(d) : "—";
}

/** "08:00" — horario de abertura dos lances (data_final), no fuso de Brasilia. */
export function formatHoraBr(value: string | null | undefined): string {
  const d = parse(value);
  return d ? HORA_BR.format(d) : "—";
}

/** "há 14 min" / "há 2 h" / "há 3 d" — KPI de ultima sincronizacao. */
export function formatRelative(value: string | null | undefined): string {
  const d = parse(value);
  if (!d) return "—";
  const diffMs = Date.now() - d.getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return `há ${days} d`;
}

/** Inteiro com separador pt-BR ("8.412"). */
export function formatNumber(value: number | null | undefined): string {
  return NUMBER.format(value ?? 0);
}

/** "R$ 1.250,00" — valores monetarios do grid de precos; null/undefined -> "—". */
export function formatCurrency(value: number | null | undefined): string {
  return value == null ? "—" : CURRENCY.format(value);
}

/**
 * Duracao da execucao. O backend pode entregar um interval Postgres
 * ("00:01:48") ou uma string ja formatada; normaliza para "1m 48s".
 */
export function formatDuracao(value: string | null | undefined): string {
  if (!value) return "—";
  const hms = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(value);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const s = Number(hms[3]);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  return value;
}

/** "Manual" / "Agendada" a partir do enum de gatilho do backend. */
export function formatGatilho(value: string | null | undefined): string {
  switch (value) {
    case "manual":
      return "Manual";
    case "agendada":
      return "Agendada";
    default:
      return value ? value.charAt(0).toUpperCase() + value.slice(1) : "—";
  }
}

/** "7 dias" a partir de janelaDias. */
export function formatJanela(dias: number | null | undefined): string {
  if (dias == null) return "—";
  return `${dias} ${dias === 1 ? "dia" : "dias"}`;
}

/** Recurso da fonte com inicial maiuscula ("processos" -> "Processos"). */
export function formatRecurso(value: string | null | undefined): string {
  if (!value) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
