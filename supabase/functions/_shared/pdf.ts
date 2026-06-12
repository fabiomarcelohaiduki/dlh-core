// =====================================================================
// _shared/pdf.ts
// Builder minimalista de PDF (A4 retrato) sobre pdf-lib, reutilizado pelos
// documentos do Dominio H. Encapsula paginacao automatica, fontes padrao
// (Helvetica/Helvetica-Bold), titulos/secoes, pares chave-valor, paragrafos,
// tabelas com quebra de linha por celula e incorporacao de imagens JPG/PNG.
//
// Os documentos sao EFEMEROS: o resultado de finish() e um Uint8Array que o
// handler devolve como streaming binario (application/pdf), sem persistir no
// Storage. Nenhuma fonte externa/customizada e baixada: usa-se apenas as
// fontes padrao do PDF (WinAnsi), por isso o texto e saneado para WinAnsi.
// =====================================================================

import {
  PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib";

/** Dimensoes A4 em pontos (72 dpi). */
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
const BOTTOM_LIMIT = MARGIN;

const COLOR_TEXT = rgb(0.12, 0.12, 0.14);
const COLOR_MUTED = rgb(0.45, 0.45, 0.5);
const COLOR_RULE = rgb(0.8, 0.8, 0.84);
const COLOR_HEAD_BG = rgb(0.93, 0.95, 0.97);
const COLOR_ZEBRA = rgb(0.97, 0.97, 0.98);

/** Alinhamento horizontal de uma coluna de tabela. */
export type CellAlign = "left" | "right";

/** Especificacao de coluna de tabela. */
export interface TableColumn {
  header: string;
  /** Largura relativa (peso); convertida para fracao do CONTENT_WIDTH. */
  width: number;
  align?: CellAlign;
}

/**
 * Mapeia caracteres unicode comuns (aspas/travessoes/reticencias) para seus
 * equivalentes ASCII e descarta qualquer codepoint fora do alcance do WinAnsi
 * (substituido por '?'), evitando excecoes de encoding ao desenhar o texto
 * com as fontes padrao do PDF.
 */
function toWinAnsi(text: string): string {
  const replacements: Record<string, string> = {
    "\u2018": "'",
    "\u2019": "'",
    "\u201C": '"',
    "\u201D": '"',
    "\u2013": "-",
    "\u2014": "-",
    "\u2026": "...",
    "\u00A0": " ",
    "\u2022": "-",
    "\u2212": "-",
  };
  let out = "";
  for (const ch of text) {
    const mapped = replacements[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    // WinAnsi cobre 0x20-0x7E e 0xA0-0xFF; 0x80-0x9F tem buracos -> '?'.
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += ch;
    } else if (code === 0x09 || code === 0x0a) {
      out += " ";
    } else {
      out += "?";
    }
  }
  return out;
}

/** Builder de documento PDF com paginacao automatica. */
export class PdfBuilder {
  private constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
    this.cursorY = A4_HEIGHT - MARGIN;
  }

  private page: PDFPage;
  private cursorY: number;

  /** Cria um builder pronto com as fontes padrao incorporadas. */
  static async create(): Promise<PdfBuilder> {
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    return new PdfBuilder(doc, regular, bold);
  }

  /** Acesso ao PDFDocument para incorporar imagens (embedJpg/embedPng). */
  get document(): PDFDocument {
    return this.doc;
  }

  /** Garante espaco vertical para `height`; quebra de pagina quando falta. */
  private ensureSpace(height: number): void {
    if (this.cursorY - height < BOTTOM_LIMIT) {
      this.page = this.doc.addPage([A4_WIDTH, A4_HEIGHT]);
      this.cursorY = A4_HEIGHT - MARGIN;
    }
  }

  /** Quebra `text` em linhas que cabem em `maxWidth` na fonte/tamanho dados. */
  private wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const sanitized = toWinAnsi(text);
    const lines: string[] = [];
    for (const rawLine of sanitized.split("\n")) {
      const words = rawLine.split(/\s+/).filter((w) => w.length > 0);
      if (words.length === 0) {
        lines.push("");
        continue;
      }
      let current = "";
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth || current === "") {
          current = candidate;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
    }
    return lines;
  }

  /** Titulo principal do documento. */
  title(text: string): void {
    const size = 18;
    this.ensureSpace(size + 8);
    this.page.drawText(toWinAnsi(text), {
      x: MARGIN,
      y: this.cursorY - size,
      size,
      font: this.bold,
      color: COLOR_TEXT,
    });
    this.cursorY -= size + 8;
  }

  /** Linha de subtitulo/contexto (texto secundario). */
  subtitle(text: string): void {
    const size = 10;
    this.ensureSpace(size + 6);
    this.page.drawText(toWinAnsi(text), {
      x: MARGIN,
      y: this.cursorY - size,
      size,
      font: this.regular,
      color: COLOR_MUTED,
    });
    this.cursorY -= size + 10;
  }

  /** Cabecalho de secao com regua inferior. */
  heading(text: string): void {
    const size = 12;
    this.ensureSpace(size + 12);
    this.page.drawText(toWinAnsi(text), {
      x: MARGIN,
      y: this.cursorY - size,
      size,
      font: this.bold,
      color: COLOR_TEXT,
    });
    this.cursorY -= size + 4;
    this.page.drawLine({
      start: { x: MARGIN, y: this.cursorY },
      end: { x: MARGIN + CONTENT_WIDTH, y: this.cursorY },
      thickness: 0.75,
      color: COLOR_RULE,
    });
    this.cursorY -= 8;
  }

  /** Par chave-valor (rotulo em negrito + valor); quebra o valor se preciso. */
  keyValue(label: string, value: string): void {
    const size = 10;
    const labelText = `${toWinAnsi(label)}: `;
    const labelWidth = this.bold.widthOfTextAtSize(labelText, size);
    const valueWidth = CONTENT_WIDTH - labelWidth;
    const valueLines = this.wrap(value, this.regular, size, valueWidth);
    const lineHeight = size + 4;

    this.ensureSpace(lineHeight * Math.max(valueLines.length, 1));
    const baseY = this.cursorY - size;
    this.page.drawText(labelText, {
      x: MARGIN,
      y: baseY,
      size,
      font: this.bold,
      color: COLOR_TEXT,
    });

    valueLines.forEach((line, idx) => {
      this.page.drawText(line, {
        x: MARGIN + labelWidth,
        y: baseY - idx * lineHeight,
        size,
        font: this.regular,
        color: COLOR_TEXT,
      });
    });
    this.cursorY -= lineHeight * Math.max(valueLines.length, 1);
  }

  /** Paragrafo de texto corrido com quebra automatica. */
  paragraph(text: string): void {
    const size = 10;
    const lineHeight = size + 4;
    const lines = this.wrap(text, this.regular, size, CONTENT_WIDTH);
    for (const line of lines) {
      this.ensureSpace(lineHeight);
      this.page.drawText(line, {
        x: MARGIN,
        y: this.cursorY - size,
        size,
        font: this.regular,
        color: COLOR_TEXT,
      });
      this.cursorY -= lineHeight;
    }
  }

  /** Espacamento vertical explicito. */
  spacer(height = 8): void {
    this.cursorY -= height;
  }

  /**
   * Desenha uma tabela com cabecalho destacado, zebra nas linhas e quebra de
   * linha por celula. Reimprime o cabecalho a cada nova pagina.
   */
  table(columns: TableColumn[], rows: string[][]): void {
    const size = 9;
    const padding = 4;
    const lineHeight = size + 3;
    const totalWeight = columns.reduce((acc, c) => acc + c.width, 0) || 1;
    const widths = columns.map((c) => (c.width / totalWeight) * CONTENT_WIDTH);

    const drawHeader = () => {
      const headerHeight = lineHeight + padding * 2;
      this.ensureSpace(headerHeight);
      const top = this.cursorY;
      this.page.drawRectangle({
        x: MARGIN,
        y: top - headerHeight,
        width: CONTENT_WIDTH,
        height: headerHeight,
        color: COLOR_HEAD_BG,
      });
      let x = MARGIN;
      columns.forEach((col, idx) => {
        const text = toWinAnsi(col.header);
        const align = col.align ?? "left";
        const textWidth = this.bold.widthOfTextAtSize(text, size);
        const tx = align === "right" ? x + widths[idx] - padding - textWidth : x + padding;
        this.page.drawText(text, {
          x: tx,
          y: top - padding - size,
          size,
          font: this.bold,
          color: COLOR_TEXT,
        });
        x += widths[idx];
      });
      this.cursorY = top - headerHeight;
    };

    drawHeader();

    rows.forEach((row, rowIdx) => {
      // Quebra cada celula e calcula a altura da linha pelo maior numero de
      // linhas entre as celulas.
      const cellLines = columns.map((_, colIdx) =>
        this.wrap(row[colIdx] ?? "", this.regular, size, widths[colIdx] - padding * 2)
      );
      const maxLines = cellLines.reduce((acc, l) => Math.max(acc, l.length), 1);
      const rowHeight = maxLines * lineHeight + padding * 2;

      if (this.cursorY - rowHeight < BOTTOM_LIMIT) {
        this.page = this.doc.addPage([A4_WIDTH, A4_HEIGHT]);
        this.cursorY = A4_HEIGHT - MARGIN;
        drawHeader();
      }

      const top = this.cursorY;
      if (rowIdx % 2 === 1) {
        this.page.drawRectangle({
          x: MARGIN,
          y: top - rowHeight,
          width: CONTENT_WIDTH,
          height: rowHeight,
          color: COLOR_ZEBRA,
        });
      }

      let x = MARGIN;
      columns.forEach((col, colIdx) => {
        const align = col.align ?? "left";
        cellLines[colIdx].forEach((line, lineIdx) => {
          const textWidth = this.regular.widthOfTextAtSize(line, size);
          const tx = align === "right" ? x + widths[colIdx] - padding - textWidth : x + padding;
          this.page.drawText(line, {
            x: tx,
            y: top - padding - size - lineIdx * lineHeight,
            size,
            font: this.regular,
            color: COLOR_TEXT,
          });
        });
        x += widths[colIdx];
      });

      this.cursorY = top - rowHeight;
    });

    // Regua inferior fechando a tabela.
    this.page.drawLine({
      start: { x: MARGIN, y: this.cursorY },
      end: { x: MARGIN + CONTENT_WIDTH, y: this.cursorY },
      thickness: 0.5,
      color: COLOR_RULE,
    });
    this.cursorY -= 6;
  }

  /**
   * Incorpora e desenha uma imagem (JPG ou PNG) limitada a `maxWidth`/`maxHeight`,
   * preservando proporcao. Legenda opcional em texto secundario. Retorna false
   * quando o formato nao e suportado (a imagem e simplesmente omitida).
   */
  async image(
    bytes: Uint8Array,
    mime: string,
    opts: { maxWidth?: number; maxHeight?: number; caption?: string | null } = {},
  ): Promise<boolean> {
    let embedded: PDFImage;
    try {
      if (mime === "image/jpeg" || mime === "image/jpg") {
        embedded = await this.doc.embedJpg(bytes);
      } else if (mime === "image/png") {
        embedded = await this.doc.embedPng(bytes);
      } else {
        return false;
      }
    } catch {
      // Bytes corrompidos/formato inesperado: omite a imagem sem abortar o PDF.
      return false;
    }

    const maxWidth = Math.min(opts.maxWidth ?? CONTENT_WIDTH, CONTENT_WIDTH);
    const maxHeight = opts.maxHeight ?? 220;
    const scale = Math.min(maxWidth / embedded.width, maxHeight / embedded.height, 1);
    const width = embedded.width * scale;
    const height = embedded.height * scale;

    const captionHeight = opts.caption ? 14 : 0;
    this.ensureSpace(height + captionHeight + 6);

    this.page.drawImage(embedded, {
      x: MARGIN,
      y: this.cursorY - height,
      width,
      height,
    });
    this.cursorY -= height + 2;

    if (opts.caption) {
      this.page.drawText(toWinAnsi(opts.caption), {
        x: MARGIN,
        y: this.cursorY - 9,
        size: 9,
        font: this.regular,
        color: COLOR_MUTED,
      });
      this.cursorY -= captionHeight;
    }
    this.cursorY -= 6;
    return true;
  }

  /** Finaliza e serializa o PDF em bytes. */
  async finish(): Promise<Uint8Array> {
    return await this.doc.save();
  }
}
