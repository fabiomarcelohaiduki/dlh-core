import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Roadmap do dlh-core — leitura server-side dos MDs em `docs/roadmap/`.
 *
 * Provisório: serve um índice navegável de decisões/ideias/pendências enquanto
 * a Lia ainda não tem módulo próprio no banco. Lê filesystem a cada request
 * (a `(cockpit)/layout.tsx` força dynamic), então editar o MD reflete no
 * cockpit no próximo refresh do browser — sem cache, sem banco, sem migration.
 */

export type RoadmapStatusEmoji = "🟡" | "🔵" | "🟢" | "⚫" | "✅" | "❔";

export type RoadmapItem = {
  /** slug sem extensão (ex: "janela-do-substrato") */
  slug: string;
  /** Primeiro H1 do MD */
  title: string;
  /** Linha completa "**Status:** 🟡 ..." (ou "❔" se não tem) */
  statusLabel: string;
  /** Emoji do status (ou "❔") */
  statusEmoji: RoadmapStatusEmoji;
  /** Data ISO extraída do status, ou null */
  statusDate: string | null;
  /** Resumo: primeiro parágrafo após o bloco de metadados */
  summary: string;
  /** Data da última atualização do MD (mtime do arquivo) */
  atualizadoEm: string;
};

/** Detalhe de um item, pronto pra renderizar markdown. */
export type RoadmapDetalhe = RoadmapItem & {
  /** Conteúdo bruto do MD (sem o H1 do título e sem o bloco de metadados) */
  content: string;
};

/** Diretório dos MDs, resolvido a partir do cwd do Next (raiz do projeto). */
function docsDir(): string {
  return path.join(process.cwd(), "docs", "roadmap");
}

const STATUS_EMOJI_PATTERN = /^\*\*Status:\*\*\s+(\S+)\s*(.*)$/;
const DATE_IN_PARENS = /\((\d{4}-\d{2}-\d{2})\)/;
const KNOWN_EMOJI: ReadonlySet<RoadmapStatusEmoji> = new Set([
  "🟡",
  "🔵",
  "🟢",
  "⚫",
  "✅",
]);

/** Lê o `**Status:** ...` no topo do MD. Retorna null se não achar. */
function parseStatus(md: string): { emoji: RoadmapStatusEmoji; label: string; date: string | null } | null {
  const firstLine = md.split("\n").find((l) => l.trim().length > 0) ?? "";
  const m = firstLine.match(STATUS_EMOJI_PATTERN) ?? md.split("\n").slice(0, 6).join("\n").match(STATUS_EMOJI_PATTERN);
  if (!m) return null;
  const rawEmoji = m[1];
  const rest = m[2].trim();
  const emoji: RoadmapStatusEmoji = KNOWN_EMOJI.has(rawEmoji as RoadmapStatusEmoji)
    ? (rawEmoji as RoadmapStatusEmoji)
    : "❔";
  const dateMatch = rest.match(DATE_IN_PARENS);
  return { emoji, label: rest, date: dateMatch ? dateMatch[1] : null };
}

/** Primeiro parágrafo após o bloco de metadados (antes do primeiro H2). */
function extractSummary(md: string): string {
  const lines = md.split("\n");
  const summary: string[] = [];
  let pastMetadata = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) continue;
    if (trimmed.startsWith("**Status:**") || trimmed.startsWith("**Última atualização:")) {
      pastMetadata = true;
      continue;
    }
    if (trimmed.startsWith("## ")) break;
    if (pastMetadata && trimmed) summary.push(trimmed);
  }
  return summary.join(" ").slice(0, 320);
}

/** Primeiro H1 (`# `) do MD, ou fallback pro slug. */
function extractTitle(md: string, slug: string): string {
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (t.startsWith("# ")) return t.slice(2).trim();
  }
  return slug;
}

/** Conteúdo do MD sem o título H1 e sem o bloco de metadados inicial. */
function extractContent(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inMetadata = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inMetadata) {
      if (trimmed.startsWith("# ")) {
        // pula o H1 do título (já temos no card)
        inMetadata = false;
        continue;
      }
      if (trimmed.startsWith("**Status:**") || trimmed.startsWith("**Última atualização:")) {
        continue;
      }
      if (trimmed === "" || trimmed.startsWith("**")) {
        // linha vazia entre metadados ou linha de metadado solta: ainda no bloco
        continue;
      }
      // primeira linha de conteúdo real: sai do bloco
      inMetadata = false;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Lista todos os MDs do diretório (ordenados por título). */
export async function listarRoadmap(): Promise<RoadmapItem[]> {
  const dir = docsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  const items = await Promise.all(
    mdFiles.map(async (file): Promise<RoadmapItem | null> => {
      const slug = file.replace(/\.md$/, "");
      // README não entra como item (é o índice)
      if (slug === "README") return null;
      const fullPath = path.join(dir, file);
      const [raw, stat] = await Promise.all([fs.readFile(fullPath, "utf8"), fs.stat(fullPath)]);
      const status = parseStatus(raw);
      return {
        slug,
        title: extractTitle(raw, slug),
        statusLabel: status ? status.label : "Sem status",
        statusEmoji: status ? status.emoji : "❔",
        statusDate: status?.date ?? null,
        summary: extractSummary(raw),
        atualizadoEm: stat.mtime.toISOString(),
      };
    }),
  );
  const filtered = items.filter((x): x is RoadmapItem => x !== null);
  filtered.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
  return filtered;
}

/** Lê um MD específico. Retorna null se não existe. */
export async function lerRoadmap(slug: string): Promise<RoadmapDetalhe | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null; // defesa contra path traversal
  const filePath = path.join(docsDir(), `${slug}.md`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const stat = await fs.stat(filePath);
  const status = parseStatus(raw);
  return {
    slug,
    title: extractTitle(raw, slug),
    statusLabel: status ? status.label : "Sem status",
    statusEmoji: status ? status.emoji : "❔",
    statusDate: status?.date ?? null,
    summary: extractSummary(raw),
    atualizadoEm: stat.mtime.toISOString(),
    content: extractContent(raw),
  };
}

/** Retorna o set de slugs existentes (pra validar wiki-links). */
export async function roadmapSlugs(): Promise<Set<string>> {
  const items = await listarRoadmap();
  return new Set(items.map((i) => i.slug));
}

/**
 * Transforma `[[slug]]` em link markdown pro detalhe correspondente. Se o slug
 * não existir no roadmap, vira texto puro (sem colchetes) — não polui o render
 * com link quebrado.
 */
export function transformWikiLinks(md: string, validSlugs: ReadonlySet<string>): string {
  return md.replace(/\[\[([a-z0-9-]+)\]\]/g, (match, slug: string) => {
    if (validSlugs.has(slug)) {
      return `[${slug}](/roadmap/${slug})`;
    }
    return slug;
  });
}
