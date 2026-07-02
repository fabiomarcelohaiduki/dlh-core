import type { SupabaseClient } from "@supabase/supabase-js";

export interface NoRef {
  tipo: string;
  id: string;
}

export interface NoVisualResolvido extends NoRef {
  label: string;
  icone: string;
  cor: string;
  estado: string;
}

const LABEL_MAX_CHARS = 120;
const SELECT_BATCH_SIZE = 500;

const DEFAULT_NO_VISUAL = {
  aviso: { label: "Aviso", icone: "file-text", cor: "#e27300" },
  processo: { label: "Processo", icone: "gavel", cor: "#f59e0b" },
  documento: { label: "Documento", icone: "file", cor: "#a1a1aa" },
  pessoa: { label: "Pessoa", icone: "user", cor: "#3b82f6" },
  produto: { label: "Produto", icone: "package", cor: "#10b981" },
  linha: { label: "Linha", icone: "layers", cor: "#8b5cf6" },
  sku: { label: "SKU", icone: "barcode", cor: "#ec4899" },
  preco: { label: "Preco", icone: "badge-dollar-sign", cor: "#22d3ee" },
  politica: { label: "Politica", icone: "shield-check", cor: "#84cc16" },
  cotacao_diretriz: { label: "Diretriz", icone: "scroll-text", cor: "#f97316" },
} as const;

interface DescritorNo {
  tabela: string;
  select: string;
  montarLabel: (row: Record<string, unknown>) => string | null;
  montarEstado: (row: Record<string, unknown>) => string;
}

function texto(row: Record<string, unknown>, campo: string): string | null {
  const valor = row[campo];
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

function truncarLabel(valor: string | null): string | null {
  if (!valor) return null;
  const limpo = valor.replace(/\s+/g, " ").trim();
  if (!limpo) return null;
  if (limpo.length <= LABEL_MAX_CHARS) return limpo;
  return `${limpo.slice(0, LABEL_MAX_CHARS - 3).trimEnd()}...`;
}

function estadoAtivo(row: Record<string, unknown>): string {
  return row.ativo === false ? "inativo" : "ativo";
}

const DESCRITORES: Record<string, DescritorNo> = {
  aviso: {
    tabela: "avisos",
    select: "id, objeto, orgao, status_indexacao",
    montarLabel: (row) => {
      const objeto = truncarLabel(texto(row, "objeto"));
      const orgao = truncarLabel(texto(row, "orgao"));
      if (orgao && objeto) return `${orgao} | ${objeto}`;
      return objeto ?? orgao;
    },
    montarEstado: (row) => texto(row, "status_indexacao") ?? "desconhecido",
  },
  processo: {
    tabela: "nomus_processos",
    select: "id, nome, status_indexacao",
    montarLabel: (row) => truncarLabel(texto(row, "nome")),
    montarEstado: (row) => texto(row, "status_indexacao") ?? "desconhecido",
  },
  pessoa: {
    tabela: "nomus_pessoas",
    select: "id, nome, nome_razao_social, ativo",
    montarLabel: (row) => truncarLabel(texto(row, "nome_razao_social") ?? texto(row, "nome")),
    montarEstado: estadoAtivo,
  },
  documento: {
    tabela: "documentos",
    select: "id, nome_arquivo, status_indexacao",
    montarLabel: (row) => truncarLabel(texto(row, "nome_arquivo")),
    montarEstado: (row) => texto(row, "status_indexacao") ?? "desconhecido",
  },
  produto: {
    tabela: "produtos",
    select: "id, nome, ativo",
    montarLabel: (row) => truncarLabel(texto(row, "nome")),
    montarEstado: estadoAtivo,
  },
  linha: {
    tabela: "produto_linhas",
    select: "id, nome, ativo",
    montarLabel: (row) => truncarLabel(texto(row, "nome")),
    montarEstado: estadoAtivo,
  },
  sku: {
    tabela: "produto_skus",
    select: "id, codigo_sku, ativo",
    montarLabel: (row) => truncarLabel(texto(row, "codigo_sku")),
    montarEstado: estadoAtivo,
  },
  preco: {
    tabela: "sku_precos_calculados",
    select: "id, regiao, patamar, estado",
    montarLabel: (row) => {
      const partes = [texto(row, "regiao"), texto(row, "patamar")].filter(Boolean);
      return partes.length > 0 ? partes.join(" / ") : null;
    },
    montarEstado: (row) => texto(row, "estado") ?? "desconhecido",
  },
  politica: {
    tabela: "politica_participacao",
    select: "id, nivel, participa",
    montarLabel: (row) => {
      const participa = texto(row, "participa");
      return participa ? `Participa: ${participa}` : "Politica";
    },
    montarEstado: (row) => texto(row, "nivel") ?? "desconhecido",
  },
  cotacao_diretriz: {
    tabela: "cotacao_diretrizes",
    select: "id, nivel, texto",
    montarLabel: (row) => truncarLabel(texto(row, "texto")) ?? "Diretriz",
    montarEstado: (row) => texto(row, "nivel") ?? "desconhecido",
  },
};

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function chaveNo(no: NoRef): string {
  return `${no.tipo}:${no.id}`;
}

function visualDefault(tipo: string): { label: string; icone: string; cor: string } {
  if (tipo in DEFAULT_NO_VISUAL) {
    return DEFAULT_NO_VISUAL[tipo as keyof typeof DEFAULT_NO_VISUAL];
  }
  return { label: tipo, icone: "circle", cor: "#a1a1aa" };
}

function montarFallback(no: NoRef): NoVisualResolvido {
  const visual = visualDefault(no.tipo);
  return {
    tipo: no.tipo,
    id: no.id,
    label: `${visual.label}: ${no.id}`,
    icone: visual.icone,
    cor: visual.cor,
    estado: "desconhecido",
  };
}

export async function resolverNosVisual(
  db: SupabaseClient,
  nos: ReadonlyArray<NoRef>,
  opts: { incluirAusentes?: boolean } = {},
): Promise<Map<string, NoVisualResolvido>> {
  const incluirAusentes = opts.incluirAusentes ?? true;
  const refsUnicas = new Map<string, NoRef>();
  for (const no of nos) {
    refsUnicas.set(chaveNo(no), no);
  }

  const idsPorTipo = new Map<string, string[]>();
  for (const no of refsUnicas.values()) {
    if (!DESCRITORES[no.tipo]) continue;
    const lista = idsPorTipo.get(no.tipo) ?? [];
    lista.push(no.id);
    idsPorTipo.set(no.tipo, lista);
  }

  const resolvidos = new Map<string, NoVisualResolvido>();

  await Promise.all(
    Array.from(idsPorTipo.entries()).flatMap(([tipo, ids]) => {
      const descritor = DESCRITORES[tipo];
      const visual = visualDefault(tipo);
      return chunks([...new Set(ids)], SELECT_BATCH_SIZE).map(async (lote) => {
        const { data, error } = await db
          .from(descritor.tabela)
          .select(descritor.select)
          .in("id", lote);
        if (error) {
          console.warn(`[relacionamentos-nos] descritor ${tipo} falhou:`, error.message);
          return;
        }
        for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
          const id = String(row.id);
          const label = descritor.montarLabel(row) ?? `${visual.label}: ${id}`;
          resolvidos.set(`${tipo}:${id}`, {
            tipo,
            id,
            label,
            icone: visual.icone,
            cor: visual.cor,
            estado: descritor.montarEstado(row),
          });
        }
      });
    }),
  );

  if (incluirAusentes) {
    for (const no of refsUnicas.values()) {
      const chave = chaveNo(no);
      if (!resolvidos.has(chave)) {
        resolvidos.set(chave, montarFallback(no));
      }
    }
  }

  return resolvidos;
}

export async function resolverNoVisual(
  db: SupabaseClient,
  no: NoRef,
): Promise<NoVisualResolvido | null> {
  const resolvidos = await resolverNosVisual(db, [no], { incluirAusentes: false });
  return resolvidos.get(chaveNo(no)) ?? null;
}
