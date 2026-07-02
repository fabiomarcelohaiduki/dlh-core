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

/**
 * Tipo de no de uma relacao. Deixou de ser enum fechado: os tipos sao DADOS
 * por org em config_tipos_no (administraveis pelo cockpit via a Edge
 * relacionamentos-tipos-no). O formato do identificador e validado no zod
 * (minusculas/digitos/underscore) e no CHECK da tabela.
 */
export type RelacionamentoTipoNo = string;

/** Combinacao possivel de uma regra (simples OU composta). */
export type RelacionamentoCombinacao = "simples" | "composta";

/**
 * Tipo do grafo de relacionamentos (V2 - dois grafos). O panorama e a busca
 * split operam sobre UM dos dois grafos por vez:
 *   - hierarquico: arestas estruturais/deterministicas (pai->filho, composicao)
 *   - semantico:   arestas inferidas por similaridade/regra (match, vinculo)
 */
export type RelacionamentoTipoGrafo = "hierarquico" | "semantico";

/** Origem do vinculo inferido pela Lia (Lia vs humano). */
export type RelacionamentoVinculoOrigem = "lia" | "humano";

/** Estado de um vinculo inferido pela Lia. */
export type RelacionamentoVinculoStatus = "rascunho" | "ativo" | "descartado";

/** Acoes possiveis em POST /relacionamentos-vinculos-lia/decidir. */
export type RelacionamentoVinculoDecisao = "aprovar" | "rejeitar" | "editar";

/** Acao de feedback inline sobre uma aresta (POST /relacionamentos-feedback). */
export type RelacionamentoFeedbackAcao = "visto" | "incorreta";

/**
 * Modo de disparo de uma regra do catalogo (esboco §4.5):
 *   - imediato:  dado novo aplica a regra na hora (hoje entra junto do agendado)
 *   - agendado:  roda no backfill agendado (pg_cron)
 *   - on-demand: NUNCA roda no cron; so em clique humano (dry-run/ativar)
 */
export type RelacionamentoModoDisparo = "imediato" | "agendado" | "on-demand";

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
  modo_disparo: RelacionamentoModoDisparo;
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
  modo_disparo?: RelacionamentoModoDisparo;
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
  modo_disparo?: RelacionamentoModoDisparo;
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
  cap_vizinhanca: number;
  profundidade_max_lia: number;
  profundidade_default_panorama: number;
  // --- V2 (dois grafos): campos aditivos da migration F2. ---
  /**
   * Teto de nos POR GRAFO. cap efetivo = cap_por_grafo ?? 200. Opcional pois
   * o backend legado pode nao expor o campo.
   */
  cap_por_grafo?: number | null;
  /** Tipo de grafo default do panorama quando ?tipo= ausente. */
  tipo_default_panorama?: RelacionamentoTipoGrafo;
  /**
   * Limiar de nos acima do qual a UI clusteriza por densidade (default 80
   * quando ausente). Puramente client-side na F2; o backend pode adotar o
   * campo em fases futuras.
   */
  clustering_threshold_nos?: number | null;
  versao: number;
  created_at: string;
  updated_at: string;
}

/** Input para atualizacao parcial da config. */
export interface ConfigRelacionamentosUpdateInput {
  uso_minimo_promocao_alternativa?: number;
  dois_caminhos_minimo?: number;
  uso_minimo_promocao?: number;
  cap_vizinhanca?: number;
  profundidade_max_lia?: number;
  profundidade_default_panorama?: number;
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

/** Aresta visual do grafo (subset estavel de 7 campos + feedback inline). */
export interface ArestaVisual {
  /**
   * Id da aresta em public.relacoes. Necessario para o feedback inline
   * (visto/incorreta). Opcional porque o panorama legado pode nao te-lo.
   */
  id?: string;
  origem_tipo: RelacionamentoTipoNo;
  origem_id: string;
  destino_tipo: RelacionamentoTipoNo;
  destino_id: string;
  /** Nome canonico da relacao (ex.: 'match', 'vinculo_inferido'). */
  relacao: string;
  metodo: string;
  confianca: number;
  // Feedback inline (F1) - preenchidos quando o backend expoe os campos.
  /** E-mail de quem marcou a aresta como vista; null quando nao vista. */
  visto_por?: string | null;
  /** Timestamp ISO de quando a aresta foi vista; null quando nao vista. */
  visto_em?: string | null;
  /** True quando um humano sinalizou a aresta como incorreta. */
  incorreta?: boolean;
  /** Motivo textual auditado da sinalizacao de incorreta; null quando limpa. */
  incorreta_motivo?: string | null;
}

/** Payload de POST /relacionamentos-feedback (feedback inline da aresta). */
export interface ArestaFeedbackInput {
  aresta_id: string;
  acao: RelacionamentoFeedbackAcao;
  /** Obrigatorio apenas na MARCACAO de incorreta. */
  motivo?: string;
}

/** Resposta de POST /relacionamentos-feedback (estado pos-toggle da aresta). */
export interface ArestaFeedbackResponse {
  aresta_id: string;
  visto_por: string | null;
  visto_em: string | null;
  incorreta: boolean;
  incorreta_motivo: string | null;
  updated_at: string;
}

/** Parametros de leitura do panorama (V2 - dois grafos). */
export interface PanoramaParams {
  /** Grafo a carregar. Omitido => backend usa tipo_default_panorama. */
  tipo?: RelacionamentoTipoGrafo;
  /** Ancora o panorama num no e devolve so a vizinhanca ate `profundidade`. */
  no_id?: string | null;
  /** Profundidade da vizinhanca ancorada. Clampada em [0, 5] no backend. */
  profundidade?: number | null;
}

/** Resposta de GET /relacionamentos-panorama. */
export interface PanoramaResponse {
  nos: NoVisual[];
  arestas: ArestaVisual[];
  /** Cap efetivamente aplicado (config da org ou default interno). */
  cap: number;
  /** True quando a quantidade de nos excedeu o cap e o retorno foi truncado. */
  truncado: boolean;
  /** Grafo efetivamente retornado (hierarquico|semantico). */
  tipo: RelacionamentoTipoGrafo;
  /** Timestamp ISO8601 de geracao da fotografia. */
  gerado_em: string;
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

/** Resposta de POST /relacionamentos-backfill (backfill e disparo manual). */
export interface BackfillResultado {
  arestas_criadas: number;
  arestas_duplicadas: number;
  erros_por_macro: Record<string, string>;
  duracao_ms: number;
  execucao_id: string;
}

// ---------------------------------------------------------------------
// Dominio: dry-run de regra (POST /relacionamentos-dry-run).
//
// Simula o impacto de UMA regra sobre o substrato REAL, SEM persistir
// (invariante read-only F3). Espelha o contrato da Edge relacionamentos-dry-run.
// ---------------------------------------------------------------------

/** Nivel agregado do score de risco de um dry-run. */
export type DryRunNivelRisco = "ok" | "aviso" | "bloqueio";

/** Alerta SOFT do score de risco (nunca bloqueia; o humano decide). */
export interface DryRunAlerta {
  /** Codigo estavel do alerta (ex.: 'cardinalidade_alta', 'duplicidade'). */
  codigo: string;
  mensagem: string;
}

/**
 * Score de risco do dry-run. Alertas `nivel='aviso'` sao SOFT e nao
 * desabilitam a ativacao. `limite_tecnico_atingido=true` (nivel='bloqueio')
 * e um bloqueio DURO que impede a ativacao.
 */
export interface DryRunScoreRisco {
  nivel: DryRunNivelRisco;
  alertas: DryRunAlerta[];
  /** True quando o volume projetado excede o limite tecnico DURO. */
  limite_tecnico_atingido?: boolean;
  /** Mensagem do bloqueio duro, quando aplicavel. */
  limite_tecnico_msg?: string;
}

/** Aresta projetada na amostra do dry-run (nao persistida). */
export interface DryRunAresta {
  origem_tipo: string;
  origem_id: string;
  destino_tipo: string;
  destino_id: string;
  relacao: string;
  metodo: string;
  confianca: number;
}

/** Limiares SOFT aplicados (config da org ou defaults). */
export interface DryRunLimiares {
  confianca_baixa: number;
  cardinalidade_alta: number;
  duplicidade_pct: number;
  amostra_insuficiente: number;
}

/** Espelho dos campos de matching da regra efetivamente simulada. */
export interface DryRunRegraTestada {
  id: string;
  nome: string | null;
  origem_tipo: string;
  campo_origem: string;
  destino_tipo: string;
  campo_destino: string;
  combinacao: RelacionamentoCombinacao;
  sequencia: string[] | null;
}

/** Resposta de POST /relacionamentos-dry-run. */
export interface DryRunResponse {
  contagem_total: number;
  amostra: DryRunAresta[];
  distribuicao_por_tipo: Record<string, number>;
  score_risco: DryRunScoreRisco;
  /** Hash dos campos de matching da regra ATUAL (gate de frescor E9). */
  regra_hash: string;
  regra_testada: DryRunRegraTestada;
  config_aplicada: DryRunLimiares;
}

/**
 * Input do dry-run. O corpo enviado a Edge contem apenas `regra_id`
 * (a Edge carrega a regra ATUAL do catalogo). `amostra_max` e reservado
 * para evolucao futura do contrato e nao e enviado enquanto a borda
 * permanecer `strict` a `regra_id`.
 */
export interface DryRunInput {
  regra_id: string;
  amostra_max?: number;
}

// ---------------------------------------------------------------------
// Dominio: guarda de ativacao (POST /relacionamentos-ativar).
//
// Ativar = efeito PERMANENTE (dispara o backfill). Gate S7 a cada
// execucao: exige dry-run FRESCO (regra_hash) + confirmacao DUPLA.
// ---------------------------------------------------------------------

/** Input da guarda de ativacao (gate S7). */
export interface AtivarRegraInput {
  regra_id: string;
  /** Hash obtido do ultimo dry-run FRESCO (E9). Divergiu no servidor => 409. */
  regra_hash: string;
  /** Confirmacao dupla: ambos devem ser true, senao 422. */
  confirmar: boolean;
  confirmar_efeito_permanente: boolean;
  /** Motivo opcional (auditado). */
  motivo?: string;
}

/** Resposta de POST /relacionamentos-ativar (guarda de ativacao). */
export interface AtivarRegraResultado {
  regra_id: string;
  executado: boolean;
  arestas_afetadas: number;
  gate: "S7";
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

// ---------------------------------------------------------------------
// Dominio: abreviacoes e cores semanticas por tipo (F4).
//
// Edge relacionamentos-abreviacoes (GET lista + PATCH lote atomico).
// Consumido pela legenda do grafo 3D e pelo editor humano de abreviacoes.
// ---------------------------------------------------------------------

/** Abreviacao + cor semantica de um tipo de no (item da legenda). */
export interface TipoAbreviacao {
  tipo: RelacionamentoTipoNo | string;
  /** Rotulo curto (<= 8 chars); null quando ainda nao definido. */
  abreviacao_padrao: string | null;
  /** Cor semantica hex #RRGGBB; null quando nao definida. */
  cor_semantica: string | null;
  /** Cor base do no (#RRGGBB ou #RRGGBBAA); pode nao vir do backend. */
  cor?: string | null;
}

/** Resposta de GET /relacionamentos-abreviacoes. */
export interface AbreviacoesResponse {
  tipos: TipoAbreviacao[];
}

/** Item do lote de PATCH /relacionamentos-abreviacoes (>=1 campo editavel). */
export interface AbreviacaoPatchItem {
  tipo: RelacionamentoTipoNo | string;
  /** <= 8 caracteres. */
  abreviacao_padrao?: string;
  /** Hex #RRGGBB (6 digitos, sem alpha). */
  cor_semantica?: string;
}

/** Input de PATCH /relacionamentos-abreviacoes (lote atomico por org). */
export interface AbreviacoesPatchInput {
  itens: AbreviacaoPatchItem[];
}

/** Resposta de PATCH /relacionamentos-abreviacoes (estado + tipos alterados). */
export interface AbreviacoesPatchResponse {
  tipos: TipoAbreviacao[];
  /** Tipos efetivamente alterados no lote. */
  alterados: string[];
}

// ---------------------------------------------------------------------
// Dominio: regras semanticas (F4) - Edge relacionamentos-regras-semanticas.
//
// 2 blocos:
//   - candidatos           -> vinculos_inferidos_lia auditaveis (ativar/
//                             desativar), paginados por KEYSET (cursor opaco).
//   - ajustes_tecnicos_lia -> config_relacionamentos RENDER-ONLY (RNF-15).
// ---------------------------------------------------------------------

/**
 * Candidato de regra semantica (vinculo inferido auditavel). Espelha as
 * colunas expostas pela Edge (CANDIDATO_COLUMNS): VinculoLia + a origem de
 * cadastro (data_origem, contexto_origem) da limpeza F0.
 */
export interface RegraSemanticaCandidato {
  id: string;
  org_id: string;
  descricao: string;
  contador_uso: number | null;
  contador_2caminhos: number | null;
  origem: RelacionamentoVinculoOrigem;
  motivo: string | null;
  regra_macro_id: string | null;
  status: RelacionamentoVinculoStatus;
  /** Timestamptz ISO de quando o candidato foi cadastrado (NOT NULL). */
  data_origem: string;
  /** Contexto textual em que a Lia cadastrou o candidato; null quando ausente. */
  contexto_origem: string | null;
  versao: number;
  created_at: string;
  updated_at: string;
}

/**
 * Ajustes tecnicos da Lia (bloco RENDER-ONLY): espelho de
 * config_relacionamentos. Campos de identidade/versao sao opcionais pois o
 * backend devolve defaults render-only quando a org ainda nao tem config.
 */
export interface AjustesTecnicosLia {
  id?: string;
  org_id: string;
  cap_por_grafo: number | null;
  clustering_threshold_nos: number | null;
  tipo_default_panorama: RelacionamentoTipoGrafo;
  cap_vizinhanca: number;
  uso_minimo_promocao: number;
  uso_minimo_promocao_alternativa: number;
  dois_caminhos_minimo: number;
  profundidade_max_lia: number;
  profundidade_default_panorama: number;
  dry_run_limiares: DryRunLimiares | null;
  versao?: number;
  created_at?: string;
  updated_at?: string;
  /** Sempre true: este bloco nunca e editavel por esta Edge (RNF-15). */
  render_only: boolean;
}

/** Resposta de GET /relacionamentos-regras-semanticas (2 blocos + keyset). */
export interface RegrasSemanticasResponse {
  candidatos: RegraSemanticaCandidato[];
  /** Cursor opaco da proxima pagina de candidatos; null quando esgotou. */
  nextCursor: string | null;
  /** Limite efetivamente aplicado na pagina. */
  limite: number;
  ajustes_tecnicos_lia: AjustesTecnicosLia;
}

/** Bloco alvo de uma acao de regra semantica. */
export type RegraSemanticaBloco = "candidatos" | "ajustes_tecnicos";

/** Operacao de acao sobre um candidato. */
export type RegraSemanticaOperacao = "ativar" | "desativar";

/**
 * Input de POST/PATCH /relacionamentos-regras-semanticas (acao sobre um bloco).
 * candidatos exige item_id; desativar exige motivo. ajustes_tecnicos -> 403.
 */
export interface RegraSemanticaAcaoInput {
  bloco: RegraSemanticaBloco;
  operacao: RegraSemanticaOperacao;
  item_id?: string;
  motivo?: string;
}

/** Parametros de leitura keyset de GET /relacionamentos-regras-semanticas. */
export interface RegrasSemanticasParams {
  cursor?: string | null;
  limite?: number | null;
}
