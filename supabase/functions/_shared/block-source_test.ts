// =====================================================================
// _shared/block-source_test.ts
// Testes PUROS (sem I/O) do seam block-source: parseEnvelope, buildEnvelope,
// isOrfa e blockOrphanStaleMs (categoria in-process da §8.1). Formato de teste
// de tabela com Deno.test. Roda com `deno test`.
// =====================================================================

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  blockOrphanStaleMs,
  buildEnvelope,
  type CheckpointModo,
  type Counters,
  envInt,
  finalizeConcluida,
  formatDuration,
  isOrfa,
  janelaMovel,
  loadCounters,
  parseEnvelope,
  updateExecucao,
} from "./block-source.ts";

const HORA_MS = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Limpa as envs que governam o teto de heartbeat (isolamento entre testes). */
function limparOrphanEnv(): void {
  Deno.env.delete("BLOCK_ORPHAN_STALE_MS");
  Deno.env.delete("EFFECTI_ORPHAN_STALE_MS");
}

// ---------------------------------------------------------------------
// parseEnvelope — validos (aninhado e legado plano)
// ---------------------------------------------------------------------

Deno.test("parseEnvelope: aninhado e legado plano produzem os mesmos campos comuns", () => {
  const comuns = {
    janela_inicio: "2026-01-01T00:00:00.000Z",
    janela_fim: "2026-01-05T00:00:00.000Z",
    fase: "coleta" as const,
    tentativas_retomada: 2,
    modo: "backfill" as const,
  };

  const aninhado = parseEnvelope({ ...comuns, cursor: { pagina_atual: 3 } });
  const legadoPlano = parseEnvelope({ ...comuns, pagina_atual: 3 });

  assert(aninhado !== null);
  assert(legadoPlano !== null);

  // Campos de ciclo comuns identicos entre os dois formatos.
  assertEquals(aninhado!.envelope, comuns);
  assertEquals(legadoPlano!.envelope, comuns);

  // Cursor: aninhado extrai `raw.cursor`; legado plano usa o proprio objeto raw.
  assertEquals(aninhado!.cursorRaw, { pagina_atual: 3 });
  assertEquals(legadoPlano!.cursorRaw, { ...comuns, pagina_atual: 3 });
});

// ---------------------------------------------------------------------
// parseEnvelope — defaults e invalidos (teste de tabela)
// ---------------------------------------------------------------------

Deno.test("parseEnvelope: defaults e casos invalidos", () => {
  // raw nao-objeto / nulo => null.
  assertEquals(parseEnvelope(null), null);
  assertEquals(parseEnvelope(42), null);

  // Sem janela_inicio (ausente ou vazia) => null.
  assertEquals(parseEnvelope({ janela_fim: "2026-01-05T00:00:00.000Z" }), null);
  assertEquals(parseEnvelope({ janela_inicio: "" }), null);

  // janela_fim vazio/ausente => default new Date().toISOString() (ISO valido,
  // NAO null: o envelope segue valido).
  const semFim = parseEnvelope({ janela_inicio: "2026-01-01T00:00:00.000Z", janela_fim: "" });
  assert(semFim !== null);
  assert(semFim!.envelope.janela_fim.length > 0);
  assert(Number.isFinite(Date.parse(semFim!.envelope.janela_fim)));

  // fase/modo lixo => defaults ("coleta" / "incremental").
  const lixo = parseEnvelope({
    janela_inicio: "2026-01-01T00:00:00.000Z",
    janela_fim: "2026-01-05T00:00:00.000Z",
    fase: "qualquer-coisa",
    modo: "outra-coisa",
  });
  assert(lixo !== null);
  assertEquals(lixo!.envelope.fase, "coleta");
  assertEquals(lixo!.envelope.modo, "incremental");

  // fase/modo literais validos sao preservados.
  const literais = parseEnvelope({
    janela_inicio: "2026-01-01T00:00:00.000Z",
    janela_fim: "2026-01-05T00:00:00.000Z",
    fase: "concluido",
    modo: "backfill",
  });
  assertEquals(literais!.envelope.fase, "concluido");
  assertEquals(literais!.envelope.modo, "backfill");

  // tentativas_retomada negativa/fracionaria => max(0, floor); ausente => 0.
  const negativa = parseEnvelope({
    janela_inicio: "2026-01-01T00:00:00.000Z",
    janela_fim: "2026-01-05T00:00:00.000Z",
    tentativas_retomada: -5,
  });
  assertEquals(negativa!.envelope.tentativas_retomada, 0);

  const fracionaria = parseEnvelope({
    janela_inicio: "2026-01-01T00:00:00.000Z",
    janela_fim: "2026-01-05T00:00:00.000Z",
    tentativas_retomada: 2.9,
  });
  assertEquals(fracionaria!.envelope.tentativas_retomada, 2);

  const ausente = parseEnvelope({
    janela_inicio: "2026-01-01T00:00:00.000Z",
    janela_fim: "2026-01-05T00:00:00.000Z",
  });
  assertEquals(ausente!.envelope.tentativas_retomada, 0);
});

// ---------------------------------------------------------------------
// buildEnvelope — campos comuns corretos + cursor passado
// ---------------------------------------------------------------------

Deno.test("buildEnvelope: campos comuns + cursor passado", () => {
  const since = new Date("2026-01-01T00:00:00.000Z");
  const until = new Date("2026-01-05T00:00:00.000Z");
  const cursor = { pagina_atual: 1, bloco_inicio: since.toISOString() };

  const casos: { modo: CheckpointModo }[] = [{ modo: "incremental" }, { modo: "backfill" }];

  for (const { modo } of casos) {
    const env = buildEnvelope({ modo, since, until }, cursor);
    assertEquals(env.janela_inicio, since.toISOString());
    assertEquals(env.janela_fim, until.toISOString());
    assertEquals(env.fase, "coleta");
    assertEquals(env.tentativas_retomada, 0);
    assertEquals(env.modo, modo);
    assertEquals(env.cursor, cursor);
  }
});

Deno.test("buildEnvelope + parseEnvelope: round-trip preserva os campos comuns", () => {
  const since = new Date("2026-02-10T12:00:00.000Z");
  const until = new Date("2026-02-15T12:00:00.000Z");
  const built = buildEnvelope({ modo: "backfill", since, until }, { pagina_atual: 7 });

  const parsed = parseEnvelope(built);
  assert(parsed !== null);
  assertEquals(parsed!.envelope, {
    janela_inicio: built.janela_inicio,
    janela_fim: built.janela_fim,
    fase: built.fase,
    tentativas_retomada: built.tentativas_retomada,
    modo: built.modo,
  });
  assertEquals(parsed!.cursorRaw, { pagina_atual: 7 });
});

// ---------------------------------------------------------------------
// isOrfa — heartbeat por updated_at (conservador)
// ---------------------------------------------------------------------

Deno.test("isOrfa: velho => true; recente => false; ilegivel/ausente => false", () => {
  limparOrphanEnv(); // usa default 600_000 (10 min)
  try {
    const agora = Date.now();

    // updated_at de 1h atras (>> 10 min) => orfa.
    assertEquals(
      isOrfa({ updated_at: new Date(agora - HORA_MS).toISOString(), inicio: "ignorado" }),
      true,
    );

    // updated_at agora => viva.
    assertEquals(
      isOrfa({ updated_at: new Date(agora).toISOString(), inicio: "ignorado" }),
      false,
    );

    // updated_at ilegivel => conservador (viva, nunca mata run legitimo).
    assertEquals(isOrfa({ updated_at: "nao-e-data", inicio: "tambem-nao" }), false);

    // updated_at ausente => fallback inicio. inicio velho => orfa.
    assertEquals(
      isOrfa({ updated_at: null, inicio: new Date(agora - HORA_MS).toISOString() }),
      true,
    );

    // updated_at ausente + inicio recente => viva.
    assertEquals(
      isOrfa({ updated_at: undefined, inicio: new Date(agora).toISOString() }),
      false,
    );

    // updated_at ausente + inicio ilegivel => conservador (viva).
    assertEquals(isOrfa({ updated_at: null, inicio: "lixo" }), false);
  } finally {
    limparOrphanEnv();
  }
});

// ---------------------------------------------------------------------
// blockOrphanStaleMs — env, default e teto > BLOCO_MAX_MS (~50s)
// ---------------------------------------------------------------------

Deno.test("blockOrphanStaleMs: respeita env, default 600_000 e sempre > 50_000", () => {
  try {
    // Default (sem nenhuma env): 10 min.
    limparOrphanEnv();
    assertEquals(blockOrphanStaleMs(), 600_000);

    // Fallback ao nome antigo (compat §7): EFFECTI_ORPHAN_STALE_MS.
    Deno.env.set("EFFECTI_ORPHAN_STALE_MS", "123456");
    assertEquals(blockOrphanStaleMs(), 123456);

    // BLOCK_ORPHAN_STALE_MS tem precedencia sobre o nome antigo.
    Deno.env.set("BLOCK_ORPHAN_STALE_MS", "777777");
    assertEquals(blockOrphanStaleMs(), 777777);

    // env invalida cai no fallback (que aqui ainda e o EFFECTI valido).
    Deno.env.set("BLOCK_ORPHAN_STALE_MS", "nao-numero");
    assertEquals(blockOrphanStaleMs(), 123456);

    // Invariante: o teto e sempre maior que o teto de bloco (~50s).
    Deno.env.delete("BLOCK_ORPHAN_STALE_MS");
    Deno.env.delete("EFFECTI_ORPHAN_STALE_MS");
    assert(blockOrphanStaleMs() > 50_000);
    Deno.env.set("BLOCK_ORPHAN_STALE_MS", "777777");
    assert(blockOrphanStaleMs() > 50_000);
  } finally {
    limparOrphanEnv();
  }
});

// =====================================================================
// Infra de teste (D2/D7): stub inline hand-rolled de SupabaseClient e spy de
// console.error. NENHUM arquivo novo — tudo vive aqui. O stub cobre apenas a
// cadeia consumida por loadCounters/updateExecucao/finalizeConcluida:
//   .from(tabela).select(...).eq(...).maybeSingle()
//   .from(tabela).update(...).eq(...)            (awaitable => { error })
// =====================================================================

interface TableResp {
  /** Resposta de .maybeSingle() (loadCounters). Default { data: null }. */
  maybeSingle?: { data: unknown };
  /** Resposta de .update(...).eq(...) (updateExecucao/finalize). Default { error: null }. */
  update?: { error: { message: string } | null };
}

/**
 * Stub hand-rolled (D2): a tabela nomeada usa `respostas`; qualquer outra tabela
 * cai num default benigno ({ data: null } / { error: null }), permitindo que
 * finalizeConcluida toque execucoes + fontes com um unico cliente. Os payloads
 * de `.update(...)` sao registrados em `updates[tabela]` para inspecao.
 */
function stubBuilder(
  tabela: string,
  respostas: TableResp,
): { db: SupabaseClient; updates: Record<string, unknown[]> } {
  const updates: Record<string, unknown[]> = {};
  const respFor = (name: string): TableResp => (name === tabela ? respostas : {});
  const db = {
    from(name: string) {
      const r = respFor(name);
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve(r.maybeSingle ?? { data: null });
        },
        update(payload: unknown) {
          (updates[name] ??= []).push(payload);
          return {
            eq() {
              return Promise.resolve(r.update ?? { error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, updates };
}

/** Instala um spy sobre console.error; restaure SEMPRE em finally (D7). */
function spyConsoleError(): { errors: unknown[][]; restore: () => void } {
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  return {
    errors,
    restore: () => {
      console.error = orig;
    },
  };
}

// ---------------------------------------------------------------------
// envInt — env valida, ausente, '0'/negativa, nao-numerica, env.get que lanca
// ---------------------------------------------------------------------

Deno.test("envInt: env valida numerica => valor (floor)", () => {
  try {
    Deno.env.set("BLOCK_ORPHAN_STALE_MS", "42");
    assertEquals(envInt("BLOCK_ORPHAN_STALE_MS", 7), 42);
    // Fracionaria positiva => floor.
    Deno.env.set("BLOCK_ORPHAN_STALE_MS", "8.9");
    assertEquals(envInt("BLOCK_ORPHAN_STALE_MS", 7), 8);
  } finally {
    limparOrphanEnv();
  }
});

Deno.test("envInt: env ausente => fallback", () => {
  limparOrphanEnv();
  try {
    assertEquals(envInt("BLOCK_ORPHAN_STALE_MS", 99), 99);
  } finally {
    limparOrphanEnv();
  }
});

Deno.test("envInt: env '0' => fallback (positivos estritos)", () => {
  try {
    Deno.env.set("BLOCK_ORPHAN_STALE_MS", "0");
    assertEquals(envInt("BLOCK_ORPHAN_STALE_MS", 55), 55);
  } finally {
    limparOrphanEnv();
  }
});

Deno.test("envInt: env negativa => fallback", () => {
  try {
    Deno.env.set("BLOCK_ORPHAN_STALE_MS", "-12");
    assertEquals(envInt("BLOCK_ORPHAN_STALE_MS", 33), 33);
  } finally {
    limparOrphanEnv();
  }
});

Deno.test("envInt: env nao-numerica => fallback", () => {
  try {
    Deno.env.set("BLOCK_ORPHAN_STALE_MS", "nao-numero");
    assertEquals(envInt("BLOCK_ORPHAN_STALE_MS", 21), 21);
  } finally {
    limparOrphanEnv();
  }
});

Deno.test("envInt: Deno.env.get que lanca => fallback", () => {
  const orig = Deno.env.get;
  // deno-lint-ignore no-explicit-any
  (Deno.env as any).get = () => {
    throw new Error("permission denied");
  };
  try {
    assertEquals(envInt("QUALQUER_VAR", 77), 77);
  } finally {
    Deno.env.get = orig;
  }
});

// ---------------------------------------------------------------------
// formatDuration — 0s, < 60s, = 60s, multi-min, edge negativo
// ---------------------------------------------------------------------

Deno.test("formatDuration: 0ms => '0s'", () => {
  assertEquals(formatDuration(0), "0s");
});

Deno.test("formatDuration: < 60s => '<s>s' (23000 => '23s')", () => {
  assertEquals(formatDuration(23000), "23s");
});

Deno.test("formatDuration: = 60s => '1m 0s'", () => {
  assertEquals(formatDuration(60000), "1m 0s");
});

Deno.test("formatDuration: multi-min => '1m 23s' (83000)", () => {
  assertEquals(formatDuration(83000), "1m 23s");
});

Deno.test("formatDuration: negativo => clamp para '0s'", () => {
  assertEquals(formatDuration(-5000), "0s");
});

// ---------------------------------------------------------------------
// janelaMovel — until default, until custom, 0 dias, negativo (futuro)
// ---------------------------------------------------------------------

Deno.test("janelaMovel: until default (new Date) => ~janelaDias antes de agora", () => {
  const antes = Date.now();
  const r = janelaMovel(7);
  const esperadoMs = antes - 7 * MS_PER_DAY;
  // Tolerancia ampla por causa do new Date() interno.
  assert(Math.abs(r.getTime() - esperadoMs) < 2000);
});

Deno.test("janelaMovel: until custom => exatamente N dias antes da data fixa", () => {
  const until = new Date("2026-02-15T12:00:00.000Z");
  const r = janelaMovel(5, until);
  assertEquals(r.toISOString(), "2026-02-10T12:00:00.000Z");
});

Deno.test("janelaMovel: 0 dias => igual a until; negativo => futuro", () => {
  const until = new Date("2026-02-15T12:00:00.000Z");
  assertEquals(janelaMovel(0, until).getTime(), until.getTime());
  // janelaDias negativo nao e validado: resulta numa data NO FUTURO de until.
  const futuro = janelaMovel(-3, until);
  assertEquals(futuro.toISOString(), "2026-02-18T12:00:00.000Z");
  assert(futuro.getTime() > until.getTime());
});

// ---------------------------------------------------------------------
// loadCounters — row presente, row nula, row parcial
// ---------------------------------------------------------------------

Deno.test("loadCounters: row presente => todos os campos lidos", async () => {
  const inicio = "2026-03-01T00:00:00.000Z";
  const { db } = stubBuilder("execucoes", {
    maybeSingle: {
      data: {
        novos: 3,
        alterados: 2,
        processados_sucesso: 5,
        processados_erro: 1,
        inicio,
      },
    },
  });
  const c = await loadCounters(db, "exec-1");
  assertEquals(c.novos, 3);
  assertEquals(c.alterados, 2);
  assertEquals(c.sucesso, 5);
  assertEquals(c.erro, 1);
  assertEquals(c.inicioMs, Date.parse(inicio));
});

Deno.test("loadCounters: row nula => contadores 0 e inicioMs = agora", async () => {
  const { db } = stubBuilder("execucoes", { maybeSingle: { data: null } });
  const antes = Date.now();
  const c = await loadCounters(db, "exec-2");
  const depois = Date.now();
  assertEquals(c.novos, 0);
  assertEquals(c.alterados, 0);
  assertEquals(c.sucesso, 0);
  assertEquals(c.erro, 0);
  assert(c.inicioMs >= antes && c.inicioMs <= depois);
});

Deno.test("loadCounters: row parcial (campos nulos) => coercidos para 0", async () => {
  const { db } = stubBuilder("execucoes", {
    maybeSingle: {
      data: {
        novos: null,
        alterados: 4,
        processados_sucesso: null,
        processados_erro: null,
        inicio: null,
      },
    },
  });
  const antes = Date.now();
  const c = await loadCounters(db, "exec-3");
  const depois = Date.now();
  assertEquals(c.novos, 0);
  assertEquals(c.alterados, 4);
  assertEquals(c.sucesso, 0);
  assertEquals(c.erro, 0);
  // inicio null => fallback Date.now().
  assert(c.inicioMs >= antes && c.inicioMs <= depois);
});

// ---------------------------------------------------------------------
// updateExecucao — feliz (sem log) e erro (log [block-source])
// ---------------------------------------------------------------------

Deno.test("updateExecucao: feliz => console.error nao e chamado", async () => {
  const { db, updates } = stubBuilder("execucoes", { update: { error: null } });
  const spy = spyConsoleError();
  try {
    await updateExecucao(db, "exec-9", { status: "em_andamento" });
  } finally {
    spy.restore();
  }
  assertEquals(spy.errors.length, 0);
  assertEquals(updates["execucoes"]?.[0], { status: "em_andamento" });
});

Deno.test("updateExecucao: erro => log [block-source] com execucaoId e error", async () => {
  const { db } = stubBuilder("execucoes", { update: { error: { message: "boom" } } });
  const spy = spyConsoleError();
  try {
    await updateExecucao(db, "exec-err", { status: "erro" });
  } finally {
    spy.restore();
  }
  assertEquals(spy.errors.length, 1);
  const [prefixo, payload] = spy.errors[0] as [string, { execucaoId: string; error: string }];
  // Confirma o prefixo canonico [block-source] (anti-drift D4).
  assert(prefixo.startsWith("[block-source]"));
  assertEquals(payload.execucaoId, "exec-err");
  assertEquals(payload.error, "boom");
});

// ---------------------------------------------------------------------
// finalizeConcluida — feliz, erro em fontes.update, idempotencia
// ---------------------------------------------------------------------

Deno.test("finalizeConcluida: feliz => execucoes (concluida) + fontes.ultima_coleta_em", async () => {
  const { db, updates } = stubBuilder("fontes", { update: { error: null } });
  const counters: Counters = {
    novos: 1,
    alterados: 2,
    sucesso: 3,
    erro: 0,
    inicioMs: Date.now() - 83000,
  };
  const spy = spyConsoleError();
  try {
    await finalizeConcluida(db, "exec-fin", "fonte-1", { cursor: { pagina_atual: 2 } }, counters);
  } finally {
    spy.restore();
  }
  assertEquals(spy.errors.length, 0);

  const patchExec = updates["execucoes"]?.[0] as Record<string, unknown>;
  assertEquals(patchExec.status, "concluida");
  assertEquals(patchExec.etapa_atual, null);
  assertEquals(patchExec.novos, 1);
  assertEquals(patchExec.alterados, 2);
  assertEquals(patchExec.processados_sucesso, 3);
  assertEquals(patchExec.processados_erro, 0);
  assertEquals(patchExec.checkpoint, { cursor: { pagina_atual: 2 } });
  assert(typeof patchExec.fim === "string");
  // duracao formatada via formatDuration (~83s => "1m 23s").
  assertEquals(patchExec.duracao, "1m 23s");

  const patchFonte = updates["fontes"]?.[0] as Record<string, unknown>;
  assert(typeof patchFonte.ultima_coleta_em === "string");
});

Deno.test("finalizeConcluida: erro em fontes.update => log [block-source], conclusao nao interrompida", async () => {
  const { db, updates } = stubBuilder("fontes", { update: { error: { message: "fonte-down" } } });
  const counters: Counters = { novos: 0, alterados: 0, sucesso: 0, erro: 0, inicioMs: Date.now() };
  const spy = spyConsoleError();
  try {
    await finalizeConcluida(db, "exec-x", "fonte-x", {}, counters);
  } finally {
    spy.restore();
  }
  // execucoes foi concluida ANTES da falha de fontes (nao interrompido).
  const patchExec = updates["execucoes"]?.[0] as Record<string, unknown>;
  assertEquals(patchExec.status, "concluida");
  // a unica falha logada e a de fontes, com prefixo canonico.
  assertEquals(spy.errors.length, 1);
  const [prefixo, payload] = spy.errors[0] as [string, { fonteId: string; error: string }];
  // Confirma o prefixo canonico [block-source] (anti-drift D4).
  assert(prefixo.startsWith("[block-source]"));
  assertEquals(payload.fonteId, "fonte-x");
  assertEquals(payload.error, "fonte-down");
});

Deno.test("finalizeConcluida: idempotente => 2x sem excecao, status permanece concluida", async () => {
  const { db, updates } = stubBuilder("fontes", { update: { error: null } });
  const counters: Counters = { novos: 0, alterados: 0, sucesso: 0, erro: 0, inicioMs: Date.now() };
  const spy = spyConsoleError();
  try {
    await finalizeConcluida(db, "exec-idem", "fonte-idem", {}, counters);
    await finalizeConcluida(db, "exec-idem", "fonte-idem", {}, counters);
  } finally {
    spy.restore();
  }
  assertEquals(spy.errors.length, 0);
  assertEquals(updates["execucoes"]?.length, 2);
  assertEquals(updates["fontes"]?.length, 2);
  assertEquals((updates["execucoes"][0] as Record<string, unknown>).status, "concluida");
  assertEquals((updates["execucoes"][1] as Record<string, unknown>).status, "concluida");
});
