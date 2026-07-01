// =====================================================================
// Tipos compartilhados da feature "Relacionamentos".
//
// Espelham o contrato das Edge Functions:
//   - relacionamentos-regras        (catalogo_regras_vinculo)
//   - relacionamentos-vinculos-lia  (vinculos_inferidos_lia)
//   - relacionamentos-config        (config_relacionamentos + config_tipos_no)
//   - relacionamentos-panorama      (leitura do grafo)
//   - relacionamentos-vizinhanca    (travessia a partir de 1 no)
//   - relacionamentos-backfill      (POST de reprocessamento)
//
// Convencao: o backend devolve snake_case (espelha as tabelas). A UI consome
// esses tipos no mesmo formato e so converte para camelCase em camadas que
// misturam com o dominio de outros modulos (aqui mantemos snake_case fiel).
// =====================================================================

// ---------------------------------------------------------------------
// Enums canonicos (espelham supabase/functions/_shared/validation.ts).
// ---------------------------------------------------------------------

/** Tipos de no permitidos nas relacoes (allowlist deterministica). */
export type RelacionamentoTipoNo =
  | "aviso"
  | "processo"
  | "documento"
  | "pessoa"
  | "produto"
  | "linha"
  | "sku"
  | "preco"
  | "politica"
  | "cotacao_diretriz";

/** Combinacao possivel de uma regra (simples OU composta). */
export type RelacionamentoCombinacao = "simples" | "composta";

/** Origem do vinculo inferido pela Lia (Lia vs humano). */
export type RelacionamentoVinculoOrigem = "lia" | "humano";

/** Estado de um vinculo inferido pela Lia. */
export type RelacionamentoVinculoStatus = "proposta" | "ativa" | "rejeitada";

/** Acoes possiveis em POST /relacionamentos-vinculos-lia/decidir. */
export type RelacionamentoVinculoDecisao = "aprovar" | "rejeitar" | "editar";

// ---------------------------------------------------------------------
// Dominio: catalogo de regras humanas (catalogo_regras_vinculo).
// ---------------------------------------------------------------------

/** Regra humana persistida no catalogo de vinculos. */
export interface Regra {
  id: string;
  org_id: string;
  nome: string | null;
  origem_tipo: RelacionamentoTipoNo;
  campo_origem: string;
  destino_tipo: RelacionamentoTipoNo;
  campo_destino: string;
  combinacao: RelacionamentoCombinacao;
  /** Ordem de composicao de campos (regra composta); null para regras simples. */
  sequencia: string[] | null;
  ativa: boolean;
  versao: number;
  created_at: string;
  updated_at: string;
}

/** Input para criacao de uma regra humana. */
export interface RegraCreateInput {
  origem_tipo: RelacionamentoTipoNo;
  campo_origem: string;
  destino_tipo: RelacionamentoTipoNo;
  campo_destino: string;
  combinacao: RelacionacaoCombinacao;
  sequencia?: string[] | null;
  ativa?: boolean;
  nome?: string | null;
}

/** Input para atualizacao parcial de uma regra humana. */
export interface RegraUpdateInput {
  origem_tipo?: RelacionamentoTipoNo;
  campo_origem?: string;
  destino_tipo?: RelacionamentoTipoNo;
  campo_destino?: string;
  combinacao?: RelacionamentoCombinacao;
  sequencia?: string[] | null;
  ativa?: boolean;
  nome?: string | null;
}

/** Atalho de tipo para evitar import circular (espelha o enum). */
export type RelacionacaoCombinacao = RelacionamentoCombinacao;

// ---------------------------------------------------------------------
// Dominio: vinculos inferidos pela Lia (vinculos_inferidos_lia).
// ---------------------------------------------------------------------

/** Vinculo inferido pela Lia (memoria operacional da IA). */
export interface VinculoLia {
  id: string;
  org_id: string;
  descricao: string;
  contador_uso: number | null;
  contador_2caminhos: number | null;
  origem: RelacionamentoVinculoOrigem;
  motivo: string | null;
  regra_macro_id: string | null;
  status: RelacionamentoVinculoStatus;
  versao: number;
  created_at: string;
  updated_at: string;
}

/** Input para POST /relacionamentos-vinculos-lia (criar vinculo manual). */
export interface VinculoLiaCreateInput {
  descricao: string;
  origem: RelacionamentoVinculoOrigem;
  contador_uso?: number | null;
  contador_2caminhos?: number | null;
  regra_macro_id?: string | null;
  motivo?: string | null;
}

/** Input para PUT /relacionamentos-vinculos-lia/:id (edicao parcial). */
export interface VinculoLiaUpdateInput {
  descricao?: string;
  contador_uso?: number | null;
  contador_2caminhos?: number | null;
  motivo?: string | null;
}

/** Dados estruturados que compoem uma nova regra humana ao aprovar. */
export interface VinculoLiaDecidirDados {
  origem_tipo: RelacionamentoTipoNo;
  destino_tipo: RelacionamentoTipoNo;
  combinacao: RelacionamentoCombinacao;
  sequencia?: string[] | null;
  nome?: string | null;
}

/** Input para POST /relacionamentos-vinculos-lia/decidir. */
export interface VinculoLiaDecidirInput {
  vinculo_id: string;
  acao: RelacionamentoVinculoDecisao;
  dados: VinculoLiaDecidirDados;
  motivo?: string;
  descricao?: string;
}

// ---------------------------------------------------------------------
// Dominio: config da org (config_relacionamentos + config_tipos_no).
// ---------------------------------------------------------------------

/** Config singleton por org (limiares de promocao de regras inferidas). */
export interface ConfigRelacionamentos {
  id: string;
  org_id: string;
  uso_minimo_promocao_alternativa: number;
  dois_caminhos_minimo: number;
  uso_minimo_promocao: number;
  /** Teto de nos exibidos no panorama (null = sem teto na org). */
  cap_panorama: number | null;
  cap_vizinhanca: number;
  profundidade_max_lia: number;
  profundidade_default_panorama: number;
  versao: number;
  created_at: string;
  updated_at: string;
}

/** Input para atualizacao parcial da config. */
export interface ConfigRelacionamentosUpdateInput {
  uso_minimo_promocao_alternativa?: number;
  dois_caminhos_minimo?: number;
  uso_minimo_promocao?: number;
  cap_panorama?: number | null;
  cap_vizinhanca?: number;
  profundidade_max_lia?: number;
  profundidade_default_panorama?: number;
}

/** Metadata visual de um tipo de no (config_tipos_no). */
export interface ConfigTipoNo {
  id: string;
  org_id: string;
  tipo: RelacionamentoTipoNo;
  label: string;
  /** Identificador do icone (lucide-react); resolvido pela UI. */
  icone: string;
  /** Cor hex do no (#RRGGBB ou #RRGGBBAA). */
  cor: string;
  ordem: number;
  ativo: boolean;
  versao: number;
  created_at: string;
  updated_at: string;
}

/** Input para criacao de um tipo de no. */
export interface ConfigTipoNoCreateInput {
  tipo: RelacionamentoTipoNo;
  label: string;
  icone: string;
  cor: string;
  ordem?: number;
  ativo?: boolean;
}

/** Input para atualizacao de um tipo de no (id ou tipo obrigatorio). */
export interface ConfigTipoNoUpdateInput {
  id?: string;
  tipo?: RelacionamentoTipoNo;
  label?: string;
  icone?: string;
  cor?: string;
  ordem?: number;
  ativo?: boolean;
}

// ---------------------------------------------------------------------
// Dominio: leitura do grafo (panorama e vizinhanca).
// ---------------------------------------------------------------------

/** No visual com metadata resolvida (label/icone/cor) para render. */
export interface NoVisual {
  tipo: RelacionamentoTipoNo;
  id: string;
  label: string;
  /** Nome do icone lucide-react (sem prefixo). */
  icone: string;
  /** Cor hex (#RRGGBB). */
  cor: string;
}

/** Aresta visual do grafo (subset estavel de 7 campos). */
export interface ArestaVisual {
  origem_tipo: RelacionamentoTipoNo;
  origem_id: string;
  destino_tipo: RelacionamentoTipoNo;
  destino_id: string;
  /** Nome canonico da relacao (ex.: 'match', 'vinculo_inferido'). */
  relacao: string;
  metodo: string;
  confianca: number;
}

/** Resposta de GET /relacionamentos-panorama. */
export interface PanoramaResponse {
  nos: NoVisual[];
  arestas: ArestaVisual[];
  /** Cap efetivamente aplicado (config da org ou default interno). */
  cap: number;
  /** True quando a quantidade de nos excedeu o cap e o retorno foi truncado. */
  truncado: boolean;
}

/** No vizinho com a profundidade a partir da ancora e o caminho percorrido. */
export interface VizinhoVisual extends NoVisual {
  /** Distancia em saltos a partir da ancora (0 = propria ancora). */
  profundidade: number;
  /** Caminho de tipos percorrido a partir da ancora. */
  caminho: string[];
}

/** Resposta de POST /relacionamentos-vizinhanca. */
export interface VizinhancaResponse {
  no_ancora: NoVisual;
  nos: VizinhoVisual[];
}

// ---------------------------------------------------------------------
// Dominio: backfill / reprocessamento.
// ---------------------------------------------------------------------

/** Resposta de POST /relacionamentos-backfill e /relacionamentos-reprocessar. */
export interface BackfillResultado {
  arestas_criadas: number;
  arestas_duplicadas: number;
  erros_por_macro: Record<string, string>;
  duracao_ms: number;
  execucao_id: string;
}

// ---------------------------------------------------------------------
// Envelope paginado padrao das listagens de Relacionamentos.
// ---------------------------------------------------------------------

/** Resposta paginada de listagens (regras, vinculos, etc). */
export interface RelacionamentoPaginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------
// Filtros de listagem (regras e vinculos Lia).
// ---------------------------------------------------------------------

/** Filtro de listagem das regras humanas. */
export interface ListRelacionamentosRegrasParams {
  ativa?: boolean;
  limit?: number;
  offset?: number;
}

/** Filtro de listagem dos vinculos inferidos pela Lia. */
export interface ListRelacionamentosVinculosParams {
  status?: RelacionamentoVinculoStatus;
  origem?: RelacionamentoVinculoOrigem;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------
// Input do POST /relacionamentos-vizinhanca.
// ---------------------------------------------------------------------

/** Payload de entrada para travessia da teia a partir de 1 no. */
export interface RelacionamentosVizinhancaInput {
  tipo: RelacionamentoTipoNo;
  id: string;
  /** Clampado em [0, 5] no backend. Default 2 quando omitido. */
  profundidade?: number;
}
