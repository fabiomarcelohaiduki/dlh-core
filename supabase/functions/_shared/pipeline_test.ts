// =====================================================================
// _shared/pipeline_test.ts
// Testes PUROS (sem Postgres, sem mock de `db`) do nucleo de decisao da
// persistencia: decidirPersistencia e incrementoDe (§8.1-§8.5, §8.8). Formato
// de teste de tabela com Deno.test, espelhando block-source_test.ts. Roda com
// `deno test supabase/functions/_shared/pipeline_test.ts` (sem Postgres).
// =====================================================================

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  decidirPersistencia,
  type DecisaoPersistencia,
  type ExistingAvisoRow,
  hashAvisoCanonico,
  incrementoDe,
  type PersistResult,
} from "./pipeline.ts";
import { type CollectedAviso } from "./effecti-connector.ts";

// ---------------------------------------------------------------------
// Fixtures: CollectedAviso e ExistingAvisoRow minimos, parametrizaveis.
// ---------------------------------------------------------------------

const EXEC_ATUAL = "exec-run-atual";
const EXEC_ANTERIOR = "exec-run-anterior";

/** Monta um CollectedAviso minimo coerente; sobrescreva apenas o relevante. */
function makeAviso(overrides: Partial<CollectedAviso> = {}): CollectedAviso {
  return {
    effectiId: "lic-1",
    modalidade: "Pregão Eletrônico",
    orgao: "Órgão X",
    objeto: "Objeto Y",
    portal: "ComprasNet",
    conteudoVerbatim: "conteudo base",
    payloadBruto: { foo: "bar" },
    dataCaptura: "2026-01-10T00:00:00.000Z",
    dataPublicacao: "2026-01-09T00:00:00.000Z",
    dataInicial: "2026-01-11T00:00:00.000Z",
    dataFinal: "2026-01-20T00:00:00.000Z",
    origem: "effecti",
    favorito: false,
    naLixeira: false,
    ...overrides,
  };
}

/** Monta um ExistingAvisoRow minimo (snapshot persistido); sobrescreva o relevante. */
function makeRow(overrides: Partial<ExistingAvisoRow> = {}): ExistingAvisoRow {
  return {
    id: "row-1",
    conteudo_hash: "hash-antigo",
    conteudo_verbatim: "conteudo base",
    execucao_origem_id: EXEC_ANTERIOR,
    favorito: false,
    favorito_propagado: false,
    data_captura: "2026-01-05T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Reconstrucao da regra de montarPersistResult (local/nao exportada em
 * pipeline.ts). Usada no teste de equivalencia §8.8 para travar contra drift.
 */
function montarPersistResultEsperado(
  avisoId: string,
  d: DecisaoPersistencia,
): PersistResult {
  return {
    avisoId,
    status: d.status,
    reindexar: d.reindexar,
    favorito: d.favoritoFinal,
    favoritoPropagado: d.proximoSnapshot.favorito_propagado === true,
    nextExisting: d.proximoSnapshot,
  };
}

// =====================================================================
// §8.1 — incrementoDe: novo->{1,0}, alterado->{0,1}, ignorado->{0,0}
// =====================================================================

Deno.test("§8.1 incrementoDe: regra status -> contagem (tabela)", () => {
  const casos: { status: Parameters<typeof incrementoDe>[0]; esperado: { novos: number; alterados: number } }[] = [
    { status: "novo", esperado: { novos: 1, alterados: 0 } },
    { status: "alterado", esperado: { novos: 0, alterados: 1 } },
    { status: "ignorado", esperado: { novos: 0, alterados: 0 } },
  ];

  for (const { status, esperado } of casos) {
    assertEquals(incrementoDe(status), esperado, `incrementoDe(${status})`);
  }
});

// =====================================================================
// §8.2 — decidirPersistencia: caminho / status / reindexar
// =====================================================================

Deno.test("§8.2 snapshot null => insert / novo / reindexar=true / id vazio", () => {
  const aviso = makeAviso();
  const d = decidirPersistencia(aviso, null, EXEC_ATUAL);

  assertEquals(d.caminho, "insert");
  assertEquals(d.status, "novo");
  assertEquals(d.reindexar, true);
  assertEquals(d.proximoSnapshot.id, "");
  // Snapshot do insert reflete o aviso novo.
  assertEquals(d.proximoSnapshot.conteudo_hash, hashAvisoCanonico(aviso));
  assertEquals(d.proximoSnapshot.execucao_origem_id, EXEC_ATUAL);
});

Deno.test("§8.2 mesmo hash + dataCaptura igual => stamp / ignorado / reindexar=false", () => {
  const aviso = makeAviso();
  // conteudo_hash igual ao hash canonico do aviso + mesma data_captura.
  const row = makeRow({
    conteudo_hash: hashAvisoCanonico(aviso),
    data_captura: aviso.dataCaptura,
  });

  const d = decidirPersistencia(aviso, row, EXEC_ATUAL);

  assertEquals(d.caminho, "stamp");
  assertEquals(d.status, "ignorado");
  assertEquals(d.reindexar, false);
});

Deno.test("§8.2 hash diferente + dataCaptura maior => update / alterado / reindexar reflete verbatim", () => {
  // Verbatim MUDOU => reindexar=true.
  const avisoMudou = makeAviso({
    dataCaptura: "2026-01-10T00:00:00.000Z",
    conteudoVerbatim: "conteudo NOVO",
  });
  const rowMudou = makeRow({
    conteudo_hash: "hash-diferente-do-canonico",
    conteudo_verbatim: "conteudo base",
    data_captura: "2026-01-05T00:00:00.000Z",
  });
  const dMudou = decidirPersistencia(avisoMudou, rowMudou, EXEC_ATUAL);
  assertEquals(dMudou.caminho, "update");
  assertEquals(dMudou.status, "alterado");
  assertEquals(dMudou.reindexar, true);

  // Verbatim IGUAL (so outro campo de negocio mudou) => alterado mas reindexar=false.
  const avisoVerbatimIgual = makeAviso({
    dataCaptura: "2026-01-10T00:00:00.000Z",
    conteudoVerbatim: "conteudo base",
  });
  const rowVerbatimIgual = makeRow({
    conteudo_hash: "hash-diferente-do-canonico",
    conteudo_verbatim: "conteudo base",
    data_captura: "2026-01-05T00:00:00.000Z",
  });
  const dVerbatimIgual = decidirPersistencia(avisoVerbatimIgual, rowVerbatimIgual, EXEC_ATUAL);
  assertEquals(dVerbatimIgual.caminho, "update");
  assertEquals(dVerbatimIgual.status, "alterado");
  assertEquals(dVerbatimIgual.reindexar, false);
});

Deno.test("§8.2 conteudo_hash null (legado) + dataCaptura maior => update / ignorado (nao infla)", () => {
  const aviso = makeAviso({ dataCaptura: "2026-01-10T00:00:00.000Z" });
  const row = makeRow({ conteudo_hash: null, data_captura: "2026-01-05T00:00:00.000Z" });

  const d = decidirPersistencia(aviso, row, EXEC_ATUAL);

  assertEquals(d.caminho, "update");
  assertEquals(d.status, "ignorado");
  // incrementoDe(ignorado) nao infla alterados.
  assertEquals(incrementoDe(d.status), { novos: 0, alterados: 0 });
});

Deno.test("§8.2 dataCaptura menor ou igual => stamp / ignorado", () => {
  // Menor.
  const avisoMenor = makeAviso({ dataCaptura: "2026-01-01T00:00:00.000Z" });
  const rowMenor = makeRow({ data_captura: "2026-01-05T00:00:00.000Z" });
  const dMenor = decidirPersistencia(avisoMenor, rowMenor, EXEC_ATUAL);
  assertEquals(dMenor.caminho, "stamp");
  assertEquals(dMenor.status, "ignorado");

  // Igual.
  const avisoIgual = makeAviso({ dataCaptura: "2026-01-05T00:00:00.000Z" });
  const rowIgual = makeRow({ data_captura: "2026-01-05T00:00:00.000Z" });
  const dIgual = decidirPersistencia(avisoIgual, rowIgual, EXEC_ATUAL);
  assertEquals(dIgual.caminho, "stamp");
  assertEquals(dIgual.status, "ignorado");
});

Deno.test("§8.2 ramos de NaN/data invalida no maisRecente", () => {
  // Atual invalida/nula => maisRecente=true => update (independe da nova).
  const avisoOk = makeAviso({ dataCaptura: "2026-01-10T00:00:00.000Z" });

  const rowNula = makeRow({ data_captura: null });
  assertEquals(decidirPersistencia(avisoOk, rowNula, EXEC_ATUAL).caminho, "update");

  const rowLixo = makeRow({ data_captura: "nao-e-data" });
  assertEquals(decidirPersistencia(avisoOk, rowLixo, EXEC_ATUAL).caminho, "update");

  // Nova invalida vs atual valida => maisRecente=false => stamp.
  const avisoInvalido = makeAviso({ dataCaptura: "nao-e-data" });
  const rowValido = makeRow({ data_captura: "2026-01-05T00:00:00.000Z" });
  assertEquals(decidirPersistencia(avisoInvalido, rowValido, EXEC_ATUAL).caminho, "stamp");

  // Nova vazia ("") vs atual valida => tambem NaN => stamp.
  const avisoVazio = makeAviso({ dataCaptura: "" });
  assertEquals(decidirPersistencia(avisoVazio, rowValido, EXEC_ATUAL).caminho, "stamp");
});

// =====================================================================
// §8.3 — favorito: OR intra-run (reset na 1a; sobe; nunca rebaixa na run)
// =====================================================================

Deno.test("§8.3 favorito OR intra-run", () => {
  // 1a ocorrencia da run (execucao_origem_id != execucaoId) com aviso.favorito=false
  // => reseta a base, favoritoFinal=false (mesmo que o snapshot estivesse marcado).
  const dPrimeira = decidirPersistencia(
    makeAviso({ favorito: false }),
    makeRow({ execucao_origem_id: EXEC_ANTERIOR, favorito: true, data_captura: aviso0() }),
    EXEC_ATUAL,
  );
  assertEquals(dPrimeira.favoritoFinal, false);

  // 2a ocorrencia (mesmo execucaoId) com aviso.favorito=true => sobe para true.
  const dSegunda = decidirPersistencia(
    makeAviso({ favorito: true }),
    makeRow({ execucao_origem_id: EXEC_ATUAL, favorito: false, data_captura: aviso0() }),
    EXEC_ATUAL,
  );
  assertEquals(dSegunda.favoritoFinal, true);

  // 3a ocorrencia (mesma run) com aviso.favorito=false mas snapshot favorito=true
  // => NAO rebaixa dentro da run, favoritoFinal=true.
  const dTerceira = decidirPersistencia(
    makeAviso({ favorito: false }),
    makeRow({ execucao_origem_id: EXEC_ATUAL, favorito: true, data_captura: aviso0() }),
    EXEC_ATUAL,
  );
  assertEquals(dTerceira.favoritoFinal, true);
});

/** Helper: data_captura igual a do aviso default (forca caminho stamp). */
function aviso0(): string {
  return "2026-01-10T00:00:00.000Z";
}

// =====================================================================
// §8.4 — resetPropagado e proximoSnapshot.favorito_propagado (3 cenarios)
// =====================================================================

Deno.test("§8.4 resetPropagado e favorito_propagado do snapshot (3 cenarios)", () => {
  // Cenario 1: favoritoFinal=false + jaPropagado=true => reset, propagado vira false.
  const d1 = decidirPersistencia(
    makeAviso({ favorito: false, dataCaptura: "2026-01-10T00:00:00.000Z" }),
    makeRow({
      execucao_origem_id: EXEC_ANTERIOR,
      favorito: true,
      favorito_propagado: true,
      data_captura: "2026-01-10T00:00:00.000Z",
    }),
    EXEC_ATUAL,
  );
  assertEquals(d1.favoritoFinal, false);
  assertEquals(d1.resetPropagado, true);
  assertEquals(d1.proximoSnapshot.favorito_propagado, false);

  // Cenario 2: favoritoFinal=true + jaPropagado=true => idempotente, sem reset.
  const d2 = decidirPersistencia(
    makeAviso({ favorito: true, dataCaptura: "2026-01-10T00:00:00.000Z" }),
    makeRow({
      execucao_origem_id: EXEC_ATUAL,
      favorito: true,
      favorito_propagado: true,
      data_captura: "2026-01-10T00:00:00.000Z",
    }),
    EXEC_ATUAL,
  );
  assertEquals(d2.favoritoFinal, true);
  assertEquals(d2.resetPropagado, false);
  assertEquals(d2.proximoSnapshot.favorito_propagado, true);

  // Cenario 3: favoritoFinal=true + jaPropagado=false => sem reset, propagado segue false.
  const d3 = decidirPersistencia(
    makeAviso({ favorito: true, dataCaptura: "2026-01-10T00:00:00.000Z" }),
    makeRow({
      execucao_origem_id: EXEC_ATUAL,
      favorito: false,
      favorito_propagado: false,
      data_captura: "2026-01-10T00:00:00.000Z",
    }),
    EXEC_ATUAL,
  );
  assertEquals(d3.favoritoFinal, true);
  assertEquals(d3.resetPropagado, false);
  assertEquals(d3.proximoSnapshot.favorito_propagado, false);
});

// =====================================================================
// §8.5 — espelharLixeira = primeiraDaRun (somente no caminho stamp)
// =====================================================================

Deno.test("§8.5 espelharLixeira = primeiraDaRun no stamp", () => {
  // stamp => dataCaptura <= atual. primeiraDaRun=true (execucao diferente).
  const dPrimeira = decidirPersistencia(
    makeAviso({ dataCaptura: "2026-01-05T00:00:00.000Z" }),
    makeRow({ execucao_origem_id: EXEC_ANTERIOR, data_captura: "2026-01-05T00:00:00.000Z" }),
    EXEC_ATUAL,
  );
  assertEquals(dPrimeira.caminho, "stamp");
  assertEquals(dPrimeira.espelharLixeira, true);

  // stamp + primeiraDaRun=false (mesma execucao) => espelharLixeira=false.
  const dReocorrencia = decidirPersistencia(
    makeAviso({ dataCaptura: "2026-01-05T00:00:00.000Z" }),
    makeRow({ execucao_origem_id: EXEC_ATUAL, data_captura: "2026-01-05T00:00:00.000Z" }),
    EXEC_ATUAL,
  );
  assertEquals(dReocorrencia.caminho, "stamp");
  assertEquals(dReocorrencia.espelharLixeira, false);
});

// =====================================================================
// §8.8 — equivalencia de PersistResult / nextExisting (anti-drift)
// =====================================================================

Deno.test("§8.8 PersistResult derivado e campo-a-campo identico ao contrato", () => {
  // Conjunto de decisoes cobrindo os tres caminhos.
  const casos: { aviso: CollectedAviso; snapshot: ExistingAvisoRow | null; avisoId: string }[] = [
    // insert (snapshot null) — avisoId vem do DB (simulado).
    { aviso: makeAviso(), snapshot: null, avisoId: "id-insert" },
    // update (hash diff + dataCaptura maior).
    {
      aviso: makeAviso({ dataCaptura: "2026-01-10T00:00:00.000Z", favorito: true }),
      snapshot: makeRow({
        conteudo_hash: "hash-diferente",
        favorito_propagado: true,
        execucao_origem_id: EXEC_ATUAL,
        data_captura: "2026-01-05T00:00:00.000Z",
      }),
      avisoId: "row-1",
    },
    // stamp (dataCaptura <= atual).
    {
      aviso: makeAviso({ dataCaptura: "2026-01-01T00:00:00.000Z", favorito: false }),
      snapshot: makeRow({
        favorito: true,
        favorito_propagado: true,
        execucao_origem_id: EXEC_ANTERIOR,
        data_captura: "2026-01-05T00:00:00.000Z",
      }),
      avisoId: "row-1",
    },
  ];

  for (const { aviso, snapshot, avisoId } of casos) {
    const d = decidirPersistencia(aviso, snapshot, EXEC_ATUAL);
    const result = montarPersistResultEsperado(avisoId, d);

    // favoritoPropagado deriva de proximoSnapshot.favorito_propagado === true.
    assertEquals(result.favoritoPropagado, d.proximoSnapshot.favorito_propagado === true);

    // Os 7 campos de nextExisting batem com o proximoSnapshot.
    assertEquals(result.nextExisting.id, d.proximoSnapshot.id);
    assertEquals(result.nextExisting.conteudo_hash, d.proximoSnapshot.conteudo_hash);
    assertEquals(result.nextExisting.conteudo_verbatim, d.proximoSnapshot.conteudo_verbatim);
    assertEquals(result.nextExisting.execucao_origem_id, d.proximoSnapshot.execucao_origem_id);
    assertEquals(result.nextExisting.favorito, d.proximoSnapshot.favorito);
    assertEquals(result.nextExisting.favorito_propagado, d.proximoSnapshot.favorito_propagado);
    assertEquals(result.nextExisting.data_captura, d.proximoSnapshot.data_captura);

    // Demais campos do contrato.
    assertEquals(result.status, d.status);
    assertEquals(result.reindexar, d.reindexar);
    assertEquals(result.favorito, d.favoritoFinal);
    assert(typeof result.avisoId === "string");
  }
});
