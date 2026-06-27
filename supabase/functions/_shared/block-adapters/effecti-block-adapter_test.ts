// =====================================================================
// _shared/block-adapters/effecti-block-adapter_test.ts
// Testes do adapter Effecti (§8.2) e da maquina de bloco runEffectiBlock com
// conector fake (§8.3), cobrindo a regressao de tolerancia (checkpoint
// Nomus/legado => null; legado plano Effecti => retomado) e os contratos de
// §5.8. Roda com `deno test --allow-env`.
//
//   §5.8b  5xx => estado 'erro' preservando o checkpoint da ultima pagina
//          concluida e etapa_atual=null.
//   §5.8d  abort antes da pagina => 'em_andamento' com checkpoint preservado.
// =====================================================================

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  type CollectedAviso,
  type EffectiConnector,
  type EffectiPageOptions,
  type EffectiPageResult,
} from "../effecti-connector.ts";
import {
  buildInitialEffectiCheckpoint,
  type EffectiCheckpoint,
  runEffectiBlock,
} from "../effecti-pipeline.ts";
import { effectiBlockAdapter } from "./effecti-block-adapter.ts";

// ---------------------------------------------------------------------
// Fakes: SupabaseClient (query builder) + coletor de pagina Effecti
// ---------------------------------------------------------------------

type QueryResult = { data: unknown; error: unknown };

interface DbState {
  execRow: Record<string, unknown> | null;
  /** Snapshots dos patches aplicados em execucoes (em ordem). */
  execUpdates: Array<Record<string, unknown>>;
  /** Snapshots das linhas inseridas em avisos. */
  avisoInserts: Array<Record<string, unknown>>;
  /** Snapshots dos updates aplicados em avisos. */
  avisoUpdates: Array<Record<string, unknown>>;
  /** Linhas inseridas em erros_ingestao. */
  erros: Array<Record<string, unknown>>;
  /** Patches aplicados em fontes (ultima_coleta_em). */
  fontesUpdates: Array<Record<string, unknown>>;
  /** Log ordenado de eventos relevantes para asserts de ordem. */
  events: string[];
  nextId: number;
}

function newDbState(): DbState {
  return {
    execRow: {
      novos: 0,
      alterados: 0,
      processados_sucesso: 0,
      processados_erro: 0,
      inicio: new Date().toISOString(),
    },
    execUpdates: [],
    avisoInserts: [],
    avisoUpdates: [],
    erros: [],
    fontesUpdates: [],
    events: [],
    nextId: 1,
  };
}

function snapshot(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

/** Builder encadeavel e awaitable que imita o subset usado pelo pipeline. */
class FakeBuilder implements PromiseLike<QueryResult> {
  private op: "select" | "update" | "upsert" | "insert" | null = null;
  private payload: unknown;
  private filters: Record<string, unknown> = {};
  private inUsed = false;

  constructor(private state: DbState, private table: string) {}

  select(_cols?: string): this {
    if (this.op === null) this.op = "select";
    return this;
  }
  update(payload: unknown): this {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  insert(payload: unknown): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters[col] = val;
    return this;
  }
  in(col: string, vals: unknown): this {
    this.inUsed = true;
    this.filters[col] = vals;
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  maybeSingle(): Promise<QueryResult> {
    return Promise.resolve(this.compute());
  }
  single(): Promise<QueryResult> {
    return Promise.resolve(this.compute());
  }
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.compute()).then(onfulfilled, onrejected);
  }

  private compute(): QueryResult {
    const s = this.state;
    if (this.table === "execucoes") {
      if (this.op === "update") {
        s.execUpdates.push(snapshot(this.payload));
        const counters = (this.payload as Record<string, unknown>).processados_sucesso;
        s.events.push(counters === undefined ? "exec-update:plain" : "exec-update:counters");
        return { data: null, error: null };
      }
      return { data: s.execRow, error: null };
    }
    if (this.table === "avisos") {
      if (this.op === "insert") {
        const id = `aviso-${s.nextId++}`;
        s.avisoInserts.push(snapshot(this.payload));
        s.events.push(`aviso-insert:${id}`);
        return { data: { id }, error: null };
      }
      if (this.op === "update") {
        s.avisoUpdates.push(snapshot(this.payload));
        return { data: null, error: null };
      }
      // select: .in (loadExistingAvisos, nenhum existente) ou maybeSingle
      // (resolveAvisoId, so no caminho de erro).
      if (this.inUsed) return { data: [], error: null };
      return { data: null, error: null };
    }
    if (this.table === "erros_ingestao") {
      s.erros.push(snapshot(this.payload));
      s.events.push("erro-insert");
      return { data: null, error: null };
    }
    if (this.table === "fontes") {
      s.fontesUpdates.push(snapshot(this.payload));
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
}

function makeFakeDb(state: DbState): SupabaseClient {
  const client = {
    from(table: string) {
      return new FakeBuilder(state, table);
    },
  };
  return client as unknown as SupabaseClient;
}

let avisoSeq = 0;
function makeAviso(overrides: Partial<CollectedAviso> = {}): CollectedAviso {
  avisoSeq += 1;
  return {
    effectiId: `e-${avisoSeq}`,
    modalidade: "Pregão Eletrônico",
    orgao: "Orgao X",
    objeto: "Objeto Y",
    portal: "ComprasNet",
    conteudoVerbatim: "conteudo verbatim",
    payloadBruto: {},
    dataCaptura: "2026-06-02T00:00:00.000Z",
    dataPublicacao: "2026-06-01T00:00:00.000Z",
    dataInicial: null,
    dataFinal: null,
    origem: null,
    // favorito null => sem write-back (PUT favoritar) no caminho de teste.
    favorito: null,
    naLixeira: null,
    ...overrides,
  };
}

/** Superficie minima do EffectiConnector consumida por runEffectiBlock. */
interface FakeConnector {
  calls: number;
  collectPage(
    blocoInicio: Date,
    blocoFim: Date,
    pagina: number,
    options?: EffectiPageOptions,
  ): Promise<EffectiPageResult>;
  favoritarLicitacao(ids: number[], signal?: AbortSignal): Promise<boolean>;
}

/** Coletor fake: serve as paginas pre-definidas; pagina extra => vazia. */
function makeCollector(pages: EffectiPageResult[]): FakeConnector {
  return {
    calls: 0,
    collectPage(): Promise<EffectiPageResult> {
      const idx = this.calls;
      this.calls += 1;
      return Promise.resolve(pages[idx] ?? { items: [], hasMore: false });
    },
    favoritarLicitacao(): Promise<boolean> {
      return Promise.resolve(true);
    },
  };
}

/** Coletor fake que lanca (simula 5xx / fonte fora do ar) na pagina `failAt`. */
function makeThrowingCollector(
  pagesBeforeFail: EffectiPageResult[],
  failAt: number,
): FakeConnector {
  return {
    calls: 0,
    collectPage(): Promise<EffectiPageResult> {
      const idx = this.calls;
      this.calls += 1;
      if (idx === failAt) {
        return Promise.reject(new Error("erro do servico Effecti (500)"));
      }
      return Promise.resolve(pagesBeforeFail[idx] ?? { items: [], hasMore: false });
    },
    favoritarLicitacao(): Promise<boolean> {
      return Promise.resolve(true);
    },
  };
}

function asConnector(fake: FakeConnector): EffectiConnector {
  return fake as unknown as EffectiConnector;
}

const SINCE = new Date("2026-06-01T00:00:00.000Z");
const UNTIL = new Date("2026-06-08T00:00:00.000Z");

// =====================================================================
// §8.2 — Adapter: buildInitialCheckpoint / parseCheckpoint / maxRetomadas
// =====================================================================

Deno.test("adapter.buildInitialCheckpoint: cursor pagina 0 + bloco_inicio==since", () => {
  // modo FIXO 'incremental' (ignora args.modo: 'backfill' nao vaza no Effecti).
  for (const modo of ["incremental", "backfill"] as const) {
    const cp = effectiBlockAdapter.buildInitialCheckpoint({ modo, since: SINCE, until: UNTIL });
    assertEquals(cp.cursor.pagina_atual, 0);
    assertEquals(cp.cursor.bloco_inicio, SINCE.toISOString());
    assertEquals(cp.fase, "coleta");
    assertEquals(cp.tentativas_retomada, 0);
    assertEquals(cp.modo, "incremental");
    assertEquals(cp.janela_inicio, SINCE.toISOString());
    assertEquals(cp.janela_fim, UNTIL.toISOString());
  }
});

Deno.test("adapter.parseCheckpoint: checkpoint Effecti valido => cursor", () => {
  const built = effectiBlockAdapter.buildInitialCheckpoint({
    modo: "incremental",
    since: SINCE,
    until: UNTIL,
  });
  // Avanca o cursor para validar que parseCheckpoint preserva os campos.
  const persistido: EffectiCheckpoint = {
    ...built,
    tentativas_retomada: 2,
    cursor: { bloco_inicio: "2026-06-06T00:00:01.000Z", pagina_atual: 3 },
  };
  const parsed = effectiBlockAdapter.parseCheckpoint(persistido);
  assert(parsed !== null);
  assertEquals(parsed!.cursor.bloco_inicio, "2026-06-06T00:00:01.000Z");
  assertEquals(parsed!.cursor.pagina_atual, 3);
  assertEquals(parsed!.tentativas_retomada, 2);
  assertEquals(parsed!.modo, "incremental");
  assertEquals(parsed!.janela_inicio, built.janela_inicio);
});

Deno.test("adapter.parseCheckpoint: legado plano Effecti (cursor no topo) => retomado (tolerancia §8.2)", () => {
  const legado = {
    bloco_inicio: "2026-06-03T00:00:00.000Z",
    pagina_atual: 5,
    janela_inicio: "2026-06-01T00:00:00.000Z",
    janela_fim: "2026-06-08T00:00:00.000Z",
    fase: "coleta",
    tentativas_retomada: 1,
  };
  const parsed = effectiBlockAdapter.parseCheckpoint(legado);
  assert(parsed !== null);
  assertEquals(parsed!.cursor.bloco_inicio, "2026-06-03T00:00:00.000Z");
  assertEquals(parsed!.cursor.pagina_atual, 5);
  assertEquals(parsed!.tentativas_retomada, 1);
  // modo ausente no legado => fixado 'incremental'.
  assertEquals(parsed!.modo, "incremental");
});

Deno.test("adapter.parseCheckpoint: Nomus/legado sem bloco_inicio => null", () => {
  // Checkpoint Nomus (cursor pagina_atual mas SEM bloco_inicio) => null.
  assertEquals(
    effectiBlockAdapter.parseCheckpoint({
      janela_inicio: "2026-06-01T00:00:00.000Z",
      janela_fim: "2026-06-08T00:00:00.000Z",
      cursor: { pagina_atual: 2, concluido_paginas_ate: 1 },
    }),
    null,
  );
  // Legado plano Nomus (pagina_atual no topo, sem bloco_inicio) => null.
  assertEquals(
    effectiBlockAdapter.parseCheckpoint({
      janela_inicio: "2026-06-01T00:00:00.000Z",
      janela_fim: "2026-06-08T00:00:00.000Z",
      pagina_atual: 3,
    }),
    null,
  );
  // Sem janela_inicio (envelope invalido) => null.
  assertEquals(
    effectiBlockAdapter.parseCheckpoint({
      cursor: { bloco_inicio: "2026-06-01T00:00:00.000Z", pagina_atual: 0 },
    }),
    null,
  );
  // null / nao-objeto => null.
  assertEquals(effectiBlockAdapter.parseCheckpoint(null), null);
  assertEquals(effectiBlockAdapter.parseCheckpoint(42), null);
});

Deno.test("adapter.maxRetomadas: respeita EFFECTI_MAX_RETOMADAS (default 3)", () => {
  Deno.env.delete("EFFECTI_MAX_RETOMADAS");
  try {
    assertEquals(effectiBlockAdapter.maxRetomadas(), 3);
    Deno.env.set("EFFECTI_MAX_RETOMADAS", "5");
    assertEquals(effectiBlockAdapter.maxRetomadas(), 5);
    Deno.env.set("EFFECTI_MAX_RETOMADAS", "lixo");
    assertEquals(effectiBlockAdapter.maxRetomadas(), 3);
  } finally {
    Deno.env.delete("EFFECTI_MAX_RETOMADAS");
  }
});

Deno.test("adapter.tipo === 'effecti' e expoe onBlockComplete", () => {
  assertEquals(effectiBlockAdapter.tipo, "effecti");
  assert(typeof effectiBlockAdapter.onBlockComplete === "function");
});

// =====================================================================
// §8.3 — runEffectiBlock (maquina de bloco) com coletor fake
// =====================================================================

Deno.test("runBlock: pagina vazia conclui a execucao", async () => {
  const state = newDbState();
  const db = makeFakeDb(state);
  const collector = makeCollector([{ items: [], hasMore: false }]);
  const checkpoint = buildInitialEffectiCheckpoint(
    SINCE,
    new Date("2026-06-03T00:00:00.000Z"),
  );

  const outcome = await runEffectiBlock(
    { db, connector: asConnector(collector), fonteId: "fonte-1" },
    { execucaoId: "exec-1", checkpoint },
  );

  assertEquals(outcome.estado, "concluida");
  assertEquals(outcome.concluido, true);
  assertEquals(state.fontesUpdates.length, 1); // finalizeConcluida carimba a fonte.
  assert(state.execUpdates.some((p) => p.status === "concluida"));
});

Deno.test("runBlock: hasMore avanca a pagina e fica em_andamento (teto de bloco)", async () => {
  Deno.env.set("EFFECTI_BLOCO_MAX_PAGINAS", "1");
  try {
    const state = newDbState();
    const db = makeFakeDb(state);
    const collector = makeCollector([{ items: [makeAviso()], hasMore: true }]);
    const checkpoint = buildInitialEffectiCheckpoint(SINCE, UNTIL);

    const outcome = await runEffectiBlock(
      { db, connector: asConnector(collector), fonteId: "fonte-1" },
      { execucaoId: "exec-1", checkpoint },
    );

    assertEquals(outcome.estado, "em_andamento");
    assertEquals(outcome.concluido, false);
    // hasMore => avanca a pagina DENTRO do mesmo bloco (bloco_inicio intacto).
    assertEquals(outcome.checkpoint.cursor.pagina_atual, 1);
    assertEquals(outcome.checkpoint.cursor.bloco_inicio, SINCE.toISOString());
    assertEquals(collector.calls, 1);
    assertEquals(outcome.processadosSucesso, 1);
  } finally {
    Deno.env.delete("EFFECTI_BLOCO_MAX_PAGINAS");
  }
});

Deno.test("runBlock: 5xx => 'erro', checkpoint preservado e etapa_atual=null (§5.8b)", async () => {
  const state = newDbState();
  const db = makeFakeDb(state);
  // Pagina 0 OK (avanca pagina para 1); pagina 1 lanca (5xx).
  const collector = makeThrowingCollector([{ items: [makeAviso()], hasMore: true }], 1);
  const checkpoint = buildInitialEffectiCheckpoint(SINCE, UNTIL);

  const outcome = await runEffectiBlock(
    { db, connector: asConnector(collector), fonteId: "fonte-1" },
    { execucaoId: "exec-1", checkpoint },
  );

  assertEquals(outcome.estado, "erro");
  assertEquals(outcome.concluido, false);
  // Checkpoint preserva a ultima pagina concluida (0) => proxima = 1.
  assertEquals(outcome.checkpoint.cursor.pagina_atual, 1);
  assertEquals(outcome.checkpoint.cursor.bloco_inicio, SINCE.toISOString());
  // O erro de infra registra em erros_ingestao na etapa Coleta.
  assertEquals(state.erros.length, 1);
  assertEquals(state.erros[0].etapa, "Coleta");
  // A execucao foi marcada 'erro' com etapa_atual=null.
  const erroPatch = state.execUpdates.find((p) => p.status === "erro");
  assert(erroPatch !== undefined);
  assertEquals(erroPatch!.etapa_atual, null);
});

Deno.test("runBlock: abort antes da pagina => 'em_andamento' com checkpoint preservado (§5.8d)", async () => {
  const state = newDbState();
  const db = makeFakeDb(state);
  const collector = makeCollector([{ items: [makeAviso()], hasMore: true }]);
  const checkpoint = buildInitialEffectiCheckpoint(SINCE, UNTIL);

  const controller = new AbortController();
  controller.abort(); // aborta ANTES de qualquer pagina.

  const outcome = await runEffectiBlock(
    { db, connector: asConnector(collector), fonteId: "fonte-1" },
    { execucaoId: "exec-1", checkpoint, signal: controller.signal },
  );

  assertEquals(outcome.estado, "em_andamento");
  assertEquals(outcome.concluido, false);
  // Checkpoint preservado: nenhuma pagina coletada => cursor intacto.
  assertEquals(outcome.checkpoint.cursor.pagina_atual, 0);
  assertEquals(outcome.checkpoint.cursor.bloco_inicio, SINCE.toISOString());
  assertEquals(collector.calls, 0);
  assertEquals(state.avisoInserts.length, 0);
});

// =====================================================================
// onBlockComplete — best-effort (nunca propaga erro)
// =====================================================================

Deno.test("onBlockComplete: rpc que LANCA nao propaga erro", async () => {
  const db = {
    rpc(_name: string, _args: unknown): Promise<{ error: unknown }> {
      throw new Error("rpc explodiu");
    },
  } as unknown as SupabaseClient;

  // Nao deve lancar.
  await effectiBlockAdapter.onBlockComplete!(
    {
      db,
      fonte: { id: "f", tipo: "effecti", endpoint_base: "x", ordem: 1 },
      token: "t",
      config: null,
    },
    "exec-1",
  );
});

Deno.test("onBlockComplete: rpc que retorna error apenas loga, nao propaga", async () => {
  let chamou = false;
  const db = {
    rpc(name: string, _args: unknown): Promise<{ error: unknown }> {
      chamou = true;
      assertEquals(name, "descobrir_vinculos_effecti");
      return Promise.resolve({ error: { message: "falha sql" } });
    },
  } as unknown as SupabaseClient;

  await effectiBlockAdapter.onBlockComplete!(
    {
      db,
      fonte: { id: "f", tipo: "effecti", endpoint_base: "x", ordem: 1 },
      token: "t",
      config: null,
    },
    "exec-1",
  );
  assert(chamou);
});

// =====================================================================
// §8.3 — adapter.runBlock compoe o EffectiConnector via fetch stub
// =====================================================================

Deno.test("adapter.runBlock: instancia EffectiConnector e delega (fetch stub)", async () => {
  const state = newDbState();
  const db = makeFakeDb(state);

  // Stub do fetch global: resposta = array vazio => primeira pagina vazia.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    )) as typeof fetch;

  try {
    const outcome = await effectiBlockAdapter.runBlock(
      {
        db,
        fonte: {
          id: "fonte-1",
          tipo: "effecti",
          endpoint_base: "https://effecti.example",
          ordem: 1,
        },
        token: "chave-fake",
        config: null,
      },
      {
        execucaoId: "exec-1",
        recurso: null,
        checkpoint: effectiBlockAdapter.buildInitialCheckpoint({
          modo: "incremental",
          since: SINCE,
          until: new Date("2026-06-03T00:00:00.000Z"),
        }),
      },
    );

    assertEquals(outcome.estado, "concluida");
    assertEquals(outcome.concluido, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
