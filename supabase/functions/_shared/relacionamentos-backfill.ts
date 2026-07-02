// =====================================================================
// _shared/relacionamentos-backfill.ts
// Logica compartilhada entre a Edge `relacionamentos-backfill`
// (disparo via cron X-Cron-Secret ou sessao humana) e a guarda de
// ativacao `relacionamentos-ativar` (disparo manual via humano autorizado).
//
// Executa as 3 fases do backfill deterministico da feature Relacionamentos
// (Fase 1 do SPEC `feature-relacionamentos` / SPEC secao 3.2.1):
//
//   FASE 1 - ESTRUTURAL: queries SQL fixas para arestas canonicas (aviso
//            -> documento, sku -> produto, sku -> preco, produto ->
//            politica, produto -> cotacao_diretriz, linha -> produto).
//   FASE 2 - MATCH POR REGRAS: le `catalogo_regras_vinculo WHERE ativa=true
//            AND org_id=:orgAtiva` (catalogo e POR ORG; relacoes e GLOBAL)
//            e aplica cada regra (simples OU composta) com allowlist
//            deterministica (origem_tipo/destino_tipo em {aviso, processo,
//            documento, pessoa, produto, linha, sku}).
//   FASE 3 - AVISO -> PRODUTO VIA TRIAGEM: le `triagem_item_matches` primeiro;
//            fallback em `triagem_decisoes.produto_candidato_id`.
//
// Idempotencia: todos os inserts em `relacoes` usam ON CONFLICT
// (origem_tipo, origem_id, destino_tipo, destino_id, relacao) DO NOTHING.
// Falha em sub-rotina NAO derruba o job (RNF-11) - excecoes sao capturadas e
// adicionadas a `erros_por_macro`.
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------
// Tipos e constantes
// ---------------------------------------------------------------------

type ServiceClient = SupabaseClient;

export interface BackfillResult {
  arestas_criadas: number;
  arestas_duplicadas: number;
  erros_por_macro: Record<string, string>;
  duracao_ms: number;
  execucao_id: string;
}

/**
 * Tipos de no permitidos para a aresta de relacao. Usado como allowlist
 * deterministica em FASE 2 (match por regras ativas). Qualquer regra cuja
 * `origem_tipo`/`destino_tipo` esteja fora deste set e IGNORADA no backfill
 * (defesa em profundidade: a regra pode existir, mas nao gera arestas).
 */
const TIPOS_NO_ALLOWLIST = new Set<string>([
  "aviso",
  "processo",
  "documento",
  "pessoa",
  "produto",
  "linha",
  "sku",
  "preco",
  "politica",
  "cotacao_diretriz",
]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------
// Helpers de insert idempotente em public.relacoes
// ---------------------------------------------------------------------

interface InsercaoRelacao {
  origem_tipo: string;
  origem_id: string;
  destino_tipo: string;
  destino_id: string;
  relacao: string;
  metodo: "deterministico" | "sugerido";
  chave: string;
  confianca: number;
}

/**
 * Deriva o tipo_relacionamento (D1, §4.11) a partir do metodo da aresta:
 * deterministico -> hierarquico; sugerido -> semantico. Sem essa derivacao
 * a coluna cai no DEFAULT 'semantico' e a aresta deterministica vai pro
 * grafo errado (mesmo mapeamento do backfill F0 sobre as arestas legadas).
 */
function tipoRelacionamentoDe(metodo: InsercaoRelacao["metodo"]): "hierarquico" | "semantico" {
  return metodo === "deterministico" ? "hierarquico" : "semantico";
}

interface ResultadoInsercao {
  criadas: number;
  duplicadas: number;
}

const RELACOES_ON_CONFLICT = "origem_tipo,origem_id,destino_tipo,destino_id,relacao";
const RELACOES_INSERT_BATCH_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Insere um lote de relacoes com idempotencia via ON CONFLICT DO NOTHING
 * (constraint unique (origem_tipo, origem_id, destino_tipo, destino_id, relacao)).
 *
 * Implementacao: usa UPSERT em lotes com ignoreDuplicates. Isso preserva a
 * idempotencia e evita 1 roundtrip por aresta quando o backfill crescer.
 *
 * Retorna { criadas, duplicadas } agregado do lote. Erros sao logados e
 * NAO derrubam o job (RNF-11).
 */
async function inserirRelacoesIdempotente(
  db: ServiceClient,
  arestas: InsercaoRelacao[],
): Promise<ResultadoInsercao> {
  let criadas = 0;
  let duplicadas = 0;
  for (const lote of chunk(arestas, RELACOES_INSERT_BATCH_SIZE)) {
    try {
      const rows = lote.map((aresta) => ({
        origem_tipo: aresta.origem_tipo,
        origem_id: aresta.origem_id,
        destino_tipo: aresta.destino_tipo,
        destino_id: aresta.destino_id,
        relacao: aresta.relacao,
        metodo: aresta.metodo,
        tipo_relacionamento: tipoRelacionamentoDe(aresta.metodo),
        chave: aresta.chave,
        confianca: aresta.confianca,
      }));
      const { data, error } = await db
        .from("relacoes")
        .upsert(rows, {
          onConflict: RELACOES_ON_CONFLICT,
          ignoreDuplicates: true,
        })
        .select("id");
      if (error) {
        // 23505 = unique_violation: idempotente. Se aparecer mesmo com
        // upsert, tratamos o lote como duplicado para manter o job andando.
        if (error.code === "23505") duplicadas += lote.length;
        else throw error;
        continue;
      }
      const inseridas = Array.isArray(data) ? data.length : 0;
      criadas += inseridas;
      duplicadas += lote.length - inseridas;
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code === "23505") {
        duplicadas += lote.length;
        continue;
      }
      throw err;
    }
  }
  return { criadas, duplicadas };
}

// ---------------------------------------------------------------------
// FASE 1 - Arestas estruturais via queries SQL fixas
// ---------------------------------------------------------------------

/**
 * FASE 1.1 - aviso -> documento: cada vinculo Effecti (documento_vinculos)
 * cuja registro_origem_id casa com um aviso existente (avisos.effecti_id)
 * gera uma aresta (aviso, documento). Chave = 'fk:documento_vinculos:<id>'
 * para proveniencia.
 */
async function fase1AvisoDocumento(
  db: ServiceClient,
): Promise<ResultadoInsercao> {
  // Plano direto: SELECT + filtro + lookup no app. Determinístico e simples.
  // Mantem o trabalho via service_role (BYPASSRLS) para gravar em relacoes.
  const { data: vinculos, error: vinculosErr } = await db
    .from("documento_vinculos")
    .select("id, fonte, registro_origem_id, documento_id")
    .eq("fonte", "effecti")
    .not("documento_id", "is", null);
  if (vinculosErr) {
    throw new Error(`fase1.1 selecionar vinculos effecti: ${vinculosErr.message}`);
  }
  const listaVinculos = (vinculos ?? []) as Array<{
    id: string;
    registro_origem_id: string;
    documento_id: string | null;
  }>;
  if (listaVinculos.length === 0) return { criadas: 0, duplicadas: 0 };

  // Resolve ids de aviso (uuid) a partir do effecti_id (text).
  const effectiIds = Array.from(new Set(listaVinculos.map((v) => v.registro_origem_id)));
  const { data: avisos, error: avisosErr } = await db
    .from("avisos")
    .select("id, effecti_id")
    .in("effecti_id", effectiIds);
  if (avisosErr) {
    throw new Error(`fase1.1 selecionar avisos por effecti_id: ${avisosErr.message}`);
  }
  const efeitoIdParaAvisoId = new Map<string, string>();
  for (const a of (avisos ?? []) as Array<{ id: string; effecti_id: string }>) {
    efeitoIdParaAvisoId.set(a.effecti_id, a.id);
  }

  const arestas: InsercaoRelacao[] = [];
  for (const v of listaVinculos) {
    const avisoId = efeitoIdParaAvisoId.get(v.registro_origem_id);
    if (!avisoId || !v.documento_id) continue;
    arestas.push({
      origem_tipo: "aviso",
      origem_id: avisoId,
      destino_tipo: "documento",
      destino_id: v.documento_id,
      relacao: "tem_anexo",
      metodo: "deterministico",
      chave: `fk:documento_vinculos:${v.id}`,
      confianca: 1.0,
    });
  }
  if (arestas.length === 0) return { criadas: 0, duplicadas: 0 };
  return await inserirRelacoesIdempotente(db, arestas);
}

/**
 * FASE 1.2 - sku -> produto: aresta canonica via produto_skus.produto_id.
 */
async function fase1SkuProduto(db: ServiceClient): Promise<ResultadoInsercao> {
  const { data, error } = await db
    .from("produto_skus")
    .select("id, produto_id");
  if (error) {
    throw new Error(`fase1.2 selecionar produto_skus: ${error.message}`);
  }
  const arestas: InsercaoRelacao[] = [];
  for (const s of (data ?? []) as Array<{ id: string; produto_id: string }>) {
    arestas.push({
      origem_tipo: "sku",
      origem_id: s.id,
      destino_tipo: "produto",
      destino_id: s.produto_id,
      relacao: "variante_de",
      metodo: "deterministico",
      chave: `fk:produto_skus:${s.id}`,
      confianca: 1.0,
    });
  }
  if (arestas.length === 0) return { criadas: 0, duplicadas: 0 };
  return await inserirRelacoesIdempotente(db, arestas);
}

/**
 * FASE 1.3 - sku -> preco: aresta canonica via sku_precos_calculados.
 * Cada linha (sku, regiao, patamar) gera 1 aresta.
 */
async function fase1SkuPreco(db: ServiceClient): Promise<ResultadoInsercao> {
  const { data, error } = await db
    .from("sku_precos_calculados")
    .select("id, sku_id, regiao, patamar");
  if (error) {
    throw new Error(`fase1.3 selecionar sku_precos_calculados: ${error.message}`);
  }
  const arestas: InsercaoRelacao[] = [];
  for (
    const p of (data ?? []) as Array<{
      id: string;
      sku_id: string;
      regiao: string;
      patamar: string;
    }>
  ) {
    arestas.push({
      origem_tipo: "sku",
      origem_id: p.sku_id,
      destino_tipo: "preco",
      destino_id: p.id,
      relacao: `tem_preco_${p.regiao}_${p.patamar}`,
      metodo: "deterministico",
      chave: `fk:sku_precos_calculados:${p.id}`,
      confianca: 1.0,
    });
  }
  if (arestas.length === 0) return { criadas: 0, duplicadas: 0 };
  return await inserirRelacoesIdempotente(db, arestas);
}

/**
 * FASE 1.4 - produto -> politica: aresta canonica via politica_participacao
 * com nivel='produto' e escopo_id = produtos.id.
 */
async function fase1ProdutoPolitica(db: ServiceClient): Promise<ResultadoInsercao> {
  const { data, error } = await db
    .from("politica_participacao")
    .select("id, nivel, escopo_id")
    .eq("nivel", "produto");
  if (error) {
    throw new Error(`fase1.4 selecionar politica_participacao produto: ${error.message}`);
  }
  const arestas: InsercaoRelacao[] = [];
  for (const p of (data ?? []) as Array<{ id: string; escopo_id: string }>) {
    arestas.push({
      origem_tipo: "produto",
      origem_id: p.escopo_id,
      destino_tipo: "politica",
      destino_id: p.id,
      relacao: "tem_politica",
      metodo: "deterministico",
      chave: `fk:politica_participacao:${p.id}`,
      confianca: 1.0,
    });
  }
  if (arestas.length === 0) return { criadas: 0, duplicadas: 0 };
  return await inserirRelacoesIdempotente(db, arestas);
}

/**
 * FASE 1.5 - produto -> cotacao_diretriz: aresta canonica via
 * cotacao_diretrizes com nivel='produto' e escopo_id = produtos.id.
 */
async function fase1ProdutoDiretriz(db: ServiceClient): Promise<ResultadoInsercao> {
  const { data, error } = await db
    .from("cotacao_diretrizes")
    .select("id, nivel, escopo_id")
    .eq("nivel", "produto");
  if (error) {
    throw new Error(`fase1.5 selecionar cotacao_diretrizes produto: ${error.message}`);
  }
  const arestas: InsercaoRelacao[] = [];
  for (const d of (data ?? []) as Array<{ id: string; escopo_id: string }>) {
    arestas.push({
      origem_tipo: "produto",
      origem_id: d.escopo_id,
      destino_tipo: "cotacao_diretriz",
      destino_id: d.id,
      relacao: "tem_diretriz",
      metodo: "deterministico",
      chave: `fk:cotacao_diretrizes:${d.id}`,
      confianca: 1.0,
    });
  }
  if (arestas.length === 0) return { criadas: 0, duplicadas: 0 };
  return await inserirRelacoesIdempotente(db, arestas);
}

/**
 * FASE 1.6 - linha -> produto: aresta canonica via produtos.linha_id.
 */
async function fase1LinhaProduto(db: ServiceClient): Promise<ResultadoInsercao> {
  const { data, error } = await db
    .from("produtos")
    .select("id, linha_id");
  if (error) {
    throw new Error(`fase1.6 selecionar produtos: ${error.message}`);
  }
  const arestas: InsercaoRelacao[] = [];
  for (const p of (data ?? []) as Array<{ id: string; linha_id: string }>) {
    arestas.push({
      origem_tipo: "linha",
      origem_id: p.linha_id,
      destino_tipo: "produto",
      destino_id: p.id,
      relacao: "contem_produto",
      metodo: "deterministico",
      chave: `fk:produtos:${p.id}`,
      confianca: 1.0,
    });
  }
  if (arestas.length === 0) return { criadas: 0, duplicadas: 0 };
  return await inserirRelacoesIdempotente(db, arestas);
}

/**
 * Executor da FASE 1 com isolamento de falhas por sub-rotina (RNF-11).
 */
async function executarFase1(
  db: ServiceClient,
  erros: Record<string, string>,
): Promise<ResultadoInsercao> {
  const subrotinas: Array<[string, () => Promise<ResultadoInsercao>]> = [
    ["fase1_aviso_documento", () => fase1AvisoDocumento(db)],
    ["fase1_sku_produto", () => fase1SkuProduto(db)],
    ["fase1_sku_preco", () => fase1SkuPreco(db)],
    ["fase1_produto_politica", () => fase1ProdutoPolitica(db)],
    ["fase1_produto_diretriz", () => fase1ProdutoDiretriz(db)],
    ["fase1_linha_produto", () => fase1LinhaProduto(db)],
  ];
  let criadas = 0;
  let duplicadas = 0;
  for (const [nome, fn] of subrotinas) {
    try {
      const r = await fn();
      criadas += r.criadas;
      duplicadas += r.duplicadas;
    } catch (err) {
      erros[nome] = errorMessage(err);
    }
  }
  return { criadas, duplicadas };
}

// ---------------------------------------------------------------------
// FASE 2 - Match por regras ativas (catalogo_regras_vinculo)
// ---------------------------------------------------------------------

interface RegraAtiva {
  id: string;
  org_id: string;
  origem_tipo: string;
  campo_origem: string;
  destino_tipo: string;
  campo_destino: string;
  combinacao: "simples" | "composta";
  sequencia: string[] | null;
}

function derivarRelacao(regra: RegraAtiva): string {
  // Para 'simples' usa o campo_destino. Para 'composta' usa sequencia.join('_')
  // (o trigger anti numero_pregao so atua em 'simples', entao composto esta livre).
  if (regra.combinacao === "composta") {
    const seq = Array.isArray(regra.sequencia) && regra.sequencia.length > 0
      ? regra.sequencia.join("_")
      : regra.campo_destino;
    return `match_${seq}`;
  }
  return `match_${regra.campo_destino}`;
}

/**
 * Aplica UMA regra ativa gerando arestas. Devolve contadores.
 * Implementacao: SELECT da tabela-fonte (origem_tipo) + JOIN no proprio
 * banco pela igualdade do campo (combinacao 'simples') OU sequencia de
 * igualdades (combinacao 'composta'). Self-loops sao ignorados (a != b).
 */
async function aplicarRegra(
  db: ServiceClient,
  regra: RegraAtiva,
): Promise<ResultadoInsercao> {
  const tipo = regra.origem_tipo;
  const relacao = derivarRelacao(regra);

  // Apenas tipos suportados pelas tabelas reais. Aviso = public.avisos,
  // processo/pessoa = public.nomus_processos / public.nomus_pessoas (a coluna
  // pode nao existir para algumas regras; nesse caso a fase 2 gera 0 arestas
  // para essa regra e segue).
  const campos: string[] = regra.combinacao === "composta"
    ? (Array.isArray(regra.sequencia) ? regra.sequencia : [regra.campo_destino])
    : [regra.campo_destino];

  // Auto-match: SELF-JOIN (origem_tipo = destino_tipo). O criterio de
  // criterio de aceite explicita "aviso<->aviso", "pessoa<->pessoa",
  // "processo<->processo" - todos SELF.
  if (regra.origem_tipo !== regra.destino_tipo) {
    // Match entre tipos distintos nao e coberto pelo escopo atual.
    return { criadas: 0, duplicadas: 0 };
  }

  // Resolve a tabela-fonte por tipo.
  const tabelaOrigem = resolverTabelaFonte(tipo);
  if (!tabelaOrigem) return { criadas: 0, duplicadas: 0 };

  // Valida que TODOS os campos existem nas colunas da tabela (defesa).
  // A RPC exec_sql nao esta disponivel; construimos a query via .from() +
  // filtros .eq() encadeados. Em caso de campo inexistente o PostgREST
  // retorna erro (registrado em erros_por_macro).

  // O nome da tabela e as colunas sao dinamicos (definidos pela regra ativa),
  // portanto o tipo do PostgREST nao consegue inferir o schema. Usamos cast
  // explicito atraves de `any` para o builder de query e mantemos o `data`
  // como `unknown[]` (validado por campo na leitura).
  // deno-lint-ignore no-explicit-any
  let query: any = db.from(tabelaOrigem).select(`id, ${campos.join(", ")}`);
  for (const campo of campos) {
    // Filtra apenas registros com o campo NAO-NULO para evitar lixo.
    query = query.not(campo, "is", null);
  }
  const { data: registros, error: selErr } = await query;
  if (selErr) {
    throw new Error(
      `selecionar ${tabelaOrigem} para regra ${regra.id}: ${selErr.message}`,
    );
  }
  const lista = (registros ?? []) as unknown as Array<Record<string, unknown>>;

  // Agrupa por chave de match (tupla dos campos) e gera pares (a, b) com a.id < b.id.
  const grupos = new Map<string, Array<{ id: string }>>();
  for (const r of lista) {
    const chave = campos.map((c) => String(r[c] ?? "")).join("|");
    if (chave === "" || campos.some((c) => String(r[c] ?? "") === "")) continue;
    const arr = grupos.get(chave) ?? [];
    arr.push({ id: String(r.id) });
    grupos.set(chave, arr);
  }

  const arestas: InsercaoRelacao[] = [];
  for (const [, items] of grupos) {
    if (items.length < 2) continue;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i].id;
        const b = items[j].id;
        // Insere nos 2 sentidos (grafo nao-direcionado); o UNIQUE cobre
        // (origem, destino, relacao) - cada par gera 2 arestas espelhadas.
        arestas.push({
          origem_tipo: tipo,
          origem_id: a,
          destino_tipo: regra.destino_tipo,
          destino_id: b,
          relacao,
          metodo: "deterministico",
          chave: `regra_macro:${regra.id}`,
          confianca: 1.0,
        });
        arestas.push({
          origem_tipo: regra.destino_tipo,
          origem_id: b,
          destino_tipo: tipo,
          destino_id: a,
          relacao,
          metodo: "deterministico",
          chave: `regra_macro:${regra.id}`,
          confianca: 1.0,
        });
      }
    }
  }
  if (arestas.length === 0) return { criadas: 0, duplicadas: 0 };
  return await inserirRelacoesIdempotente(db, arestas);
}

/**
 * Mapeia o tipo de no (origem_tipo/destino_tipo) para a tabela-fonte
 * correspondente. Retorna null se o tipo nao e suportado pela FASE 2.
 */
function resolverTabelaFonte(tipo: string): string | null {
  switch (tipo) {
    case "aviso":
      return "avisos";
    case "processo":
      return "nomus_processos";
    case "pessoa":
      return "nomus_pessoas";
    case "produto":
      return "produtos";
    case "linha":
      return "produto_linhas";
    case "sku":
      return "produto_skus";
    case "preco":
      return "sku_precos_calculados";
    case "politica":
      return "politica_participacao";
    case "cotacao_diretriz":
      return "cotacao_diretrizes";
    case "documento":
      return "documentos";
    default:
      return null;
  }
}

/**
 * Escopo da FASE 2 - consumo do `modo_disparo` (esboco §4.5).
 *   - `regraId`: restringe a UMA regra (usado pelo relacionamentos-ativar).
 *     Ignora modo_disparo: o humano pediu explicitamente ESTA regra.
 *   - `modos`: allowlist de modo_disparo no disparo global. O cron usa
 *     ['imediato','agendado'] para NUNCA rodar regra 'on-demand' fora de
 *     um clique humano. Ausente = todos os modos (disparo manual global).
 */
interface EscopoFase2 {
  regraId?: string;
  modos?: readonly string[];
}

/**
 * Executor da FASE 2 com isolamento de falhas por regra (RNF-11). Consulta
 * apenas as regras ativas DA ORG ATIVA (catalogo_regras_vinculo e POR ORG;
 * o filtro WHERE ativa=true AND org_id=:orgAtiva e obrigatorio). As arestas
 * geradas sao gravadas em `relacoes`, que e GLOBAL (sem org_id) por decisao
 * arquitetural - aqui filtramos apenas o catalogo de regras (fonte) por org.
 */
async function executarFase2(
  db: ServiceClient,
  erros: Record<string, string>,
  orgId: string,
  escopo: EscopoFase2 = {},
): Promise<ResultadoInsercao> {
  let query = db
    .from("catalogo_regras_vinculo")
    .select(
      "id, org_id, origem_tipo, campo_origem, destino_tipo, campo_destino, combinacao, sequencia",
    )
    .eq("ativa", true)
    .eq("org_id", orgId);
  if (escopo.regraId) {
    query = query.eq("id", escopo.regraId);
  } else if (escopo.modos) {
    query = query.in("modo_disparo", [...escopo.modos]);
  }
  const { data: regras, error: regrasErr } = await query;
  if (regrasErr) {
    erros["fase2_listar_regras"] = regrasErr.message;
    return { criadas: 0, duplicadas: 0 };
  }
  const ativas = (regras ?? []) as RegraAtiva[];
  let criadas = 0;
  let duplicadas = 0;
  for (const regra of ativas) {
    // Allowlist deterministica: ignora regras com tipos fora do set canonico.
    if (!TIPOS_NO_ALLOWLIST.has(regra.origem_tipo)) continue;
    if (!TIPOS_NO_ALLOWLIST.has(regra.destino_tipo)) continue;
    try {
      const r = await aplicarRegra(db, regra);
      criadas += r.criadas;
      duplicadas += r.duplicadas;
    } catch (err) {
      erros[`fase2_regra_${regra.id}`] = errorMessage(err);
    }
  }
  return { criadas, duplicadas };
}

// ---------------------------------------------------------------------
// FASE 3 - Aviso -> produto via Triagem
// ---------------------------------------------------------------------

/**
 * FASE 3 - Match aviso -> produto via Triagem.
 *
 * Fonte canonica (SPEC secao 4.5.4 do feature-relacionamentos):
 *   1) `triagem_item_matches` (match granular por item); agrupa por aviso_id
 *      e coleta o conjunto de produto_ids unicos para aquele aviso.
 *   2) Fallback: `triagem_decisoes.produto_candidato_id` (atalho por aviso).
 */
async function executarFase3(
  db: ServiceClient,
  erros: Record<string, string>,
): Promise<ResultadoInsercao> {
  let criadas = 0;
  let duplicadas = 0;

  // Caminho 1: triagem_item_matches agrupado por aviso.
  try {
    const { data: matches, error: mErr } = await db
      .from("triagem_item_matches")
      .select("aviso_id, produto_id, id")
      .not("produto_id", "is", null);
    if (mErr) {
      erros["fase3_listar_item_matches"] = mErr.message;
    } else {
      // Dedup por (aviso_id, produto_id) usando a primeira match_id vista.
      const visto = new Map<string, string>(); // key="avisoId|produtoId" -> matchId
      for (
        const m of (matches ?? []) as Array<{
          aviso_id: string;
          produto_id: string | null;
          id: string;
        }>
      ) {
        if (!m.produto_id) continue;
        const k = `${m.aviso_id}|${m.produto_id}`;
        if (!visto.has(k)) visto.set(k, m.id);
      }
      const arestas: InsercaoRelacao[] = [];
      for (const [k, matchId] of visto) {
        const [avisoId, produtoId] = k.split("|");
        arestas.push({
          origem_tipo: "aviso",
          origem_id: avisoId,
          destino_tipo: "produto",
          destino_id: produtoId,
          relacao: "produto_de",
          metodo: "deterministico",
          chave: `triagem_item_matches:${matchId}`,
          confianca: 1.0,
        });
      }
      if (arestas.length > 0) {
        const r = await inserirRelacoesIdempotente(db, arestas);
        criadas += r.criadas;
        duplicadas += r.duplicadas;
      }
    }
  } catch (err) {
    erros["fase3_item_matches"] = errorMessage(err);
  }

  // Caminho 2: fallback em triagem_decisoes.produto_candidato_id.
  // Apenas para avisos que NAO receberam aresta no caminho 1 (idempotencia
  // via ON CONFLICT DO NOTHING cobre o pior caso de duplicacao).
  try {
    const { data: decisoes, error: dErr } = await db
      .from("triagem_decisoes")
      .select("id, aviso_id, produto_candidato_id")
      .not("produto_candidato_id", "is", null)
      .order("decidido_em", { ascending: false });
    if (dErr) {
      erros["fase3_listar_decisoes"] = dErr.message;
    } else {
      // Dedup por (aviso_id, produto_id) usando a decisao mais recente.
      const visto = new Map<string, string>();
      for (
        const d of (decisoes ?? []) as Array<{
          id: string;
          aviso_id: string;
          produto_candidato_id: string | null;
        }>
      ) {
        if (!d.produto_candidato_id) continue;
        const k = `${d.aviso_id}|${d.produto_candidato_id}`;
        if (!visto.has(k)) visto.set(k, d.id);
      }
      const arestas: InsercaoRelacao[] = [];
      for (const [k, decisaoId] of visto) {
        const [avisoId, produtoId] = k.split("|");
        arestas.push({
          origem_tipo: "aviso",
          origem_id: avisoId,
          destino_tipo: "produto",
          destino_id: produtoId,
          relacao: "produto_de",
          metodo: "deterministico",
          chave: `triagem_decisoes:${decisaoId}`,
          confianca: 1.0,
        });
      }
      if (arestas.length > 0) {
        const r = await inserirRelacoesIdempotente(db, arestas);
        criadas += r.criadas;
        duplicadas += r.duplicadas;
      }
    }
  } catch (err) {
    erros["fase3_decisoes"] = errorMessage(err);
  }

  return { criadas, duplicadas };
}

// ---------------------------------------------------------------------
// Orquestracao das 3 fases e gravacao em execucoes
// ---------------------------------------------------------------------

export interface RunBackfillOptions {
  /** service_role client (BYPASSRLS). */
  db: ServiceClient;
  /** Identificador de telemetria da execucao (`execucoes.etapa_atual`). */
  etapa: string;
  /** Origem do disparo: 'agendada' (cron) ou 'manual' (humano autorizado). */
  gatilho: "agendada" | "manual";
  /**
   * UUID da org ativa do disparo. Usado pela FASE 2 para filtrar
   * `catalogo_regras_vinculo WHERE ativa=true AND org_id=:orgAtiva`
   * (catalogo e POR ORG; relacoes e GLOBAL). Em cron vem do env
   * RELACIONAMENTOS_ACTIVE_ORG_ID (single-tenant) ou do primeiro `public.org`;
   * em manual vem do `org_membership` do operador (sua org ativa).
   */
  orgId: string;
  /** Identificador da execucao ja inserida (single-flight). Pode ser null para
   * que o helper insira a propria execucao ANTES do trabalho (atomicidade). */
  execucaoId?: string;
  /**
   * Restringe o run a UMA regra do catalogo (usado pelo relacionamentos-ativar,
   * gate S7). Quando presente: pula as Fases 1 e 3 e roda SO a Fase 2 desta
   * regra, ignorando `modo_disparo` (o humano pediu explicitamente ESTA regra).
   */
  regraId?: string;
}

/**
 * Modos de disparo que o cron pode rodar (esboco §4.5). Regra 'on-demand'
 * NUNCA entra no backfill agendado - so roda em clique humano explicito.
 */
const MODOS_DISPARO_AGENDADO = ["imediato", "agendado"] as const;

/**
 * Insere um registro em `public.execucoes` representando o run de backfill.
 * Retorna o `id` (uuid) da execucao recem-inserida. Usa service_role
 * (BYPASSRLS) pois a Edge e a unica writer de telemetria para esta etapa.
 */
async function inserirExecucaoBackfill(
  db: ServiceClient,
  gatilho: "agendada" | "manual",
): Promise<string> {
  const agora = new Date().toISOString();
  const { data, error } = await db
    .from("execucoes")
    .insert({
      inicio: agora,
      gatilho,
      etapa_atual: "relacionamentos-backfill",
      status: "em_andamento",
      novos: 0,
      alterados: 0,
      checkpoint: {},
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`falha ao inserir execucao de backfill: ${error?.message ?? "sem id"}`);
  }
  return (data as { id: string }).id;
}

/**
 * Atualiza `public.execucoes` para o estado terminal ('concluida' ou 'erro')
 * com a duracao calculada. checkpoint jsonb agrega contadores para a UI.
 */
async function finalizarExecucao(
  db: ServiceClient,
  execucaoId: string,
  status: "concluida" | "erro",
  resultado: ResultadoInsercao,
  erros: Record<string, string>,
  duracaoMs: number,
): Promise<void> {
  const agora = new Date().toISOString();
  const duracao = `${Math.round(duracaoMs)}ms`;
  const { error } = await db
    .from("execucoes")
    .update({
      fim: agora,
      status,
      etapa_atual: null,
      duracao,
      novos: resultado.criadas,
      alterados: resultado.duplicadas,
      checkpoint: {
        arestas_criadas: resultado.criadas,
        arestas_duplicadas: resultado.duplicadas,
        erros_por_macro: erros,
        duracao_ms: Math.round(duracaoMs),
      },
    })
    .eq("id", execucaoId);
  if (error) {
    console.error("[relacionamentos-backfill] falha ao finalizar execucao", {
      execucaoId,
      error: error.message,
    });
  }
}

/**
 * Insere execucao, executa as 3 fases do backfill com isolamento por sub-rotina
 * (RNF-11) e finaliza a execucao. Retorna o agregado final.
 *
 * Escopo (esboco §4.5):
 *   - `regraId` presente -> roda SO a Fase 2 daquela regra (ativacao S7).
 *   - gatilho 'agendada' -> Fase 2 pula regras `on-demand` (so clique humano).
 *   - gatilho 'manual' global -> todas as fases, todos os modos.
 *
 * Single-flight NAO e tratado aqui - caller deve fazer antes de chamar
 * (consulta etapa_atual='relacionamentos-backfill' AND status='em_andamento').
 */
export async function runRelacionamentosBackfill(
  opts: RunBackfillOptions,
): Promise<BackfillResult> {
  const { db, etapa, gatilho, orgId, regraId } = opts;
  const t0 = performance.now();

  const execucaoId = opts.execucaoId ?? (await inserirExecucaoBackfill(db, gatilho));

  const erros: Record<string, string> = {};
  let criadas = 0;
  let duplicadas = 0;

  // Escopo da Fase 2 conforme a origem do disparo (ver doc acima).
  const escopoFase2: EscopoFase2 = regraId
    ? { regraId }
    : gatilho === "agendada"
    ? { modos: MODOS_DISPARO_AGENDADO }
    : {};

  try {
    if (!regraId) {
      const r1 = await executarFase1(db, erros);
      criadas += r1.criadas;
      duplicadas += r1.duplicadas;
    }

    const r2 = await executarFase2(db, erros, orgId, escopoFase2);
    criadas += r2.criadas;
    duplicadas += r2.duplicadas;

    if (!regraId) {
      const r3 = await executarFase3(db, erros);
      criadas += r3.criadas;
      duplicadas += r3.duplicadas;
    }
  } catch (err) {
    // Defesa extra: mesmo com try/catch por sub-rotina, qualquer escape
    // derruba a execucao para 'erro' (a falha de uma fase NAO deve matar o job).
    erros["fase_desconhecida"] = errorMessage(err);
  }

  const duracaoMs = performance.now() - t0;
  const temErroFatal = Object.keys(erros).length > 0;
  await finalizarExecucao(
    db,
    execucaoId,
    temErroFatal ? "erro" : "concluida",
    { criadas, duplicadas },
    erros,
    duracaoMs,
  );

  console.log(`[relacionamentos-backfill] ${etapa} concluida`, {
    execucaoId,
    arestas_criadas: criadas,
    arestas_duplicadas: duplicadas,
    erros: Object.keys(erros).length,
    duracao_ms: Math.round(duracaoMs),
  });

  return {
    arestas_criadas: criadas,
    arestas_duplicadas: duplicadas,
    erros_por_macro: erros,
    duracao_ms: Math.round(duracaoMs),
    execucao_id: execucaoId,
  };
}

/**
 * Verifica se ha execucao de backfill em andamento (single-flight). Quando
 * sim, retorna o `id` (string) da execucao ativa para o caller reportar 409.
 * Caso contrario retorna null. A consulta e direta em `execucoes` filtrando
 * `etapa_atual='relacionamentos-backfill' AND status='em_andamento'`.
 */
export async function execucaoBackfillAtiva(
  db: ServiceClient,
): Promise<string | null> {
  const { data, error } = await db
    .from("execucoes")
    .select("id")
    .eq("etapa_atual", "relacionamentos-backfill")
    .eq("status", "em_andamento")
    .limit(1)
    .maybeSingle();
  if (error) {
    // Erro de leitura NAO derruba o handler: deixamos seguir (insercao pode
    // falhar com 23505 se outra requisicao inseriu em paralelo).
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Parametros para resolver a org ativa do disparo.
 * - `db`: client service_role (BYPASSRLS).
 * - `usuarioId`: quando o disparo e manual, id do operador; `null` para cron.
 */
export interface ResolverOrgAtivaArgs {
  db: ServiceClient;
  usuarioId: string | null;
}

/**
 * Resolve a org ativa do disparo de backfill.
 *
 * Ordem de resolucao (defense in depth):
 *   1) Manual (usuarioId != null): consulta `public.org_membership` pelo
 *      usuario autenticado e retorna o `org_id` da PRIMEIRA membership.
 *   2) Fallback single-tenant: usa a env var `RELACIONAMENTOS_ACTIVE_ORG_ID`;
 *      se ausente, lê `config_relacionamentos`; se ainda ausente, usa a
 *      primeira linha de `public.org`.
 *
 * Lanca `Error` com mensagem clara quando:
 *   - nenhuma org ativa encontrada no fallback (estado inconsistente).
 */
export async function resolverOrgAtivaBackfill(
  args: ResolverOrgAtivaArgs,
): Promise<string> {
  const { db, usuarioId } = args;

  // Caminho 1: manual -> membership do operador.
  if (usuarioId) {
    const { data: memb, error: membErr } = await db
      .from("org_membership")
      .select("org_id")
      .eq("user_id", usuarioId)
      .limit(1)
      .maybeSingle();
    if (membErr) {
      throw new Error(
        `falha ao resolver org ativa do operador ${usuarioId}: ${membErr.message}`,
      );
    }
    const orgId = (memb as { org_id: string } | null)?.org_id;
    if (orgId) return orgId;
  }

  // Caminho 2: fallback single-tenant.
  const fromEnv = Deno.env.get("RELACIONAMENTOS_ACTIVE_ORG_ID")?.trim();
  if (fromEnv) return fromEnv;

  const { data: cfgRow, error: cfgErr } = await db
    .from("config_relacionamentos")
    .select("org_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (cfgErr) {
    throw new Error(`falha ao resolver org ativa por config: ${cfgErr.message}`);
  }
  const orgConfig = (cfgRow as { org_id: string } | null)?.org_id;
  if (orgConfig) return orgConfig;

  const { data: orgRow, error: orgErr } = await db
    .from("org")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (orgErr) {
    throw new Error(`falha ao resolver org ativa (cron): ${orgErr.message}`);
  }
  const fallbackId = (orgRow as { id: string } | null)?.id;
  if (!fallbackId) {
    throw new Error(
      "nenhuma org ativa encontrada para relacionamentos",
    );
  }
  return fallbackId;
}
