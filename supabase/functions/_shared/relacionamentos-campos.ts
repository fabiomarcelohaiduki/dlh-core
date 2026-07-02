// =====================================================================
// _shared/relacionamentos-campos.ts
// Parser e extrator de CAMPOS DE REGRA para o motor de Relacionamentos.
//
// Um campo de regra pode ser:
//   - COLUNA FISICA escalar         ex.: "cnpj"           -> le a coluna
//   - CAMINHO JSONB (dotted-path)   ex.: "payload_bruto.uasg"
//                                        -> le a coluna jsonb `payload_bruto`
//                                           e extrai a chave `uasg`
//
// Convencao: o PRIMEIRO segmento (antes do 1o ponto) e sempre a coluna
// fisica real; os segmentos seguintes sao o caminho de chaves DENTRO do
// jsonb dessa coluna. Assim o motor sempre faz SELECT de colunas fisicas
// (sem SQL dinamico / injecao) e extrai o valor final em memoria no Deno.
//
// Isso mantem o motor generico e config-driven: uma chave de match nova
// que viva no jsonb (uasg, processo, etc) nao exige coluna nova nem
// alteracao de codigo, so cadastrar o campo "coluna.chave" na regra.
// =====================================================================

/** Campo de regra ja decomposto em coluna fisica + caminho jsonb. */
export interface CampoParsed {
  /** Texto original do campo, como cadastrado na regra. */
  raw: string;
  /** Coluna fisica real da tabela (1o segmento). */
  coluna: string;
  /**
   * Caminho de chaves dentro do jsonb da coluna. Vazio quando o campo e
   * uma coluna fisica escalar (sem ponto).
   */
  jsonPath: string[];
}

/**
 * Decompoe UM campo de regra em coluna fisica + caminho jsonb.
 * "cnpj"               -> { coluna: "cnpj", jsonPath: [] }
 * "payload_bruto.uasg" -> { coluna: "payload_bruto", jsonPath: ["uasg"] }
 * Pontos extras aninham: "col.a.b" -> jsonPath ["a","b"].
 */
export function parseCampo(raw: string): CampoParsed {
  const partes = raw.split(".");
  const coluna = partes[0];
  const jsonPath = partes.slice(1).filter((p) => p.length > 0);
  return { raw, coluna, jsonPath };
}

/** Campo e um caminho jsonb (tem ao menos um segmento apos a coluna)? */
export function ehJsonPath(campo: CampoParsed): boolean {
  return campo.jsonPath.length > 0;
}

/**
 * Lista de COLUNAS FISICAS distintas a pedir no SELECT para um conjunto de
 * campos parseados. Varios campos jsonb da mesma coluna (payload_bruto.uasg,
 * payload_bruto.processo) colapsam numa unica coluna `payload_bruto`.
 */
export function colunasSelect(campos: CampoParsed[]): string[] {
  const set = new Set<string>();
  for (const c of campos) set.add(c.coluna);
  return [...set];
}

/**
 * Extrai o valor FINAL de UM campo a partir do registro lido.
 * - coluna fisica: devolve registro[coluna].
 * - caminho jsonb: navega registro[coluna] pelas chaves de jsonPath.
 * Retorna "" (string vazia) quando o valor e ausente/null/nao-navegavel;
 * o chamador trata "" como "sem chave de match" (registro ignorado).
 */
export function extrairValor(
  registro: Record<string, unknown>,
  campo: CampoParsed,
): string {
  let atual: unknown = registro[campo.coluna];
  for (const chave of campo.jsonPath) {
    if (atual === null || atual === undefined || typeof atual !== "object") {
      return "";
    }
    atual = (atual as Record<string, unknown>)[chave];
  }
  if (atual === null || atual === undefined) return "";
  // Valores jsonb escalares chegam como string/number/boolean; normaliza.
  if (typeof atual === "object") return "";
  return String(atual);
}

/**
 * Extrai a TUPLA de valores de match (ordem preservada) de um registro para
 * um conjunto de campos. Devolve null quando QUALQUER campo esta vazio
 * (registro nao entra em nenhum grupo - evita casar por chave parcial).
 */
export function extrairTupla(
  registro: Record<string, unknown>,
  campos: CampoParsed[],
): string[] | null {
  const valores: string[] = [];
  for (const campo of campos) {
    const v = extrairValor(registro, campo);
    if (v === "") return null;
    valores.push(v);
  }
  return valores;
}
