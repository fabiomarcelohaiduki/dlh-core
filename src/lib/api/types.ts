// =====================================================================
// Tipos do contrato publico das Edge Functions de monitoramento (camelCase).
// Espelham supabase/functions/_shared/types.ts — fonte de verdade do backend
// (sprint-002/004). Mantidos aqui para uso tipado no front sem importar Deno.
// =====================================================================

/** Status de ingestao exposto ao front (mapeado de operacional/degradado/parado). */
export type StatusIngestao = "Saudavel" | "Atencao" | "Falha";

export interface HealthcheckResponse {
  statusIngestao: StatusIngestao;
  ultimaSync: string | null;
  totalAvisos: number;
  totalProcessos: number;
  totalPessoas: number;
  itensComErro: number;
}

/** Status persistido da execucao (coluna `execucoes.status`). */
export type ExecucaoStatus = "concluida" | "em_andamento" | "erro";

/**
 * Cursor/estado de retomada da execucao (execucoes.checkpoint). Presente nas
 * fontes coletadas em blocos (Nomus e, desde 11/06, Effecti); null apenas nas
 * execucoes legadas sem checkpoint.
 */
export interface ExecucaoCheckpoint {
  paginaAtual: number | null;
  fase: string | null;
  modo: string | null;
  tentativasRetomada: number | null;
}

export interface Execucao {
  id: string;
  inicio: string;
  fim: string | null;
  gatilho: string;
  janelaDias: number | null;
  novos: number;
  alterados: number;
  duracao: string | null;
  status: string;
  etapaAtual: string | null;
  totalProcessar: number | null;
  processadosSucesso: number | null;
  processadosErro: number | null;
  pendentes: number | null;
  /** Fonte da execucao (execucoes.fonte_id); null nas execucoes legadas. */
  fonteId: string | null;
  /** Origem/tipo da fonte ('effecti' | 'nomus'); null quando indeterminada. */
  origem: string | null;
  /** Recurso coletado (ex.: 'processos'); null para o Effecti (recurso unico). */
  recurso: string | null;
  /** Tipo-alvo do recurso (ex.: tipos ativos do Nomus). */
  tipoAlvo: string | null;
  /** Cursor de paginacao/retomada; null nas execucoes legadas sem checkpoint. */
  checkpoint: ExecucaoCheckpoint | null;
}

export interface Erro {
  id: string;
  execucaoId: string | null;
  avisoId: string | null;
  severidade: string;
  etapa: string;
  mensagem: string;
  quando: string;
  statusReprocesso: string | null;
  /** Origem do registro com falha ('aviso' = Effecti; 'processo-*' = Nomus). */
  origem: string;
  /** Recurso da fonte (ex.: 'processos'); null para o Effecti. */
  recurso: string | null;
  /** Referencia generica do registro de memoria (nomus_processos.id). */
  registroId: string | null;
}

/** Alias de dominio (secao 4.3): a tabela de erros consome `ErroIngestao[]`. */
export type ErroIngestao = Erro;

export interface ExecucoesResponse {
  items: Execucao[];
}

export interface ErrosResponse {
  items: Erro[];
}

/** Metadado de um chunk gerado para o aviso (presenca/dimensao do embedding). */
export interface ChunkMetadata {
  id: string;
  ordem: number | null;
  temEmbedding: boolean;
  dimensoes: number | null;
}

/** Metadado de um arquivo de edital tratado (sem texto extraido na listagem). */
export interface ArquivoMetadata {
  id: string;
  nomeArquivo: string | null;
  extensao: string | null;
  tamanhoBytes: number | null;
  storagePath: string | null;
  statusTratamento: string | null;
}

/** Estado do indice semantico do aviso (chunks, arquivos e status). */
export interface AvisoIndice {
  statusIndexacao: string | null;
  chunks: ChunkMetadata[];
  arquivos: ArquivoMetadata[];
}

/** GET /substrato/avisos/:id — detalhe completo do aviso (api-detalhe-edital). */
export interface AvisoDetalhe {
  id: string;
  conteudoVerbatim: string;
  payloadBruto: unknown;
  indice: AvisoIndice;
}

/** POST /substrato/avisos/:id/reindexar -> status do reprocesso do item. */
export interface ReprocessarResponse {
  status: "reprocessado" | "em_andamento" | "ignorado";
}

/** POST /ingestao/coletar -> execucao criada e pipeline disparado (202). */
export interface ColetaResponse {
  execucaoId: string;
  status: "em_andamento";
}

/** Corpo de erro padrao das Edge Functions (_shared/http.ts). */
export interface ApiErrorBody {
  error?: string;
  message?: string;
}

// =====================================================================
// Administracao — Fontes/credenciais e Configuracao da ingestao.
// Espelham os contratos das Edge Functions da sprint-003 (camelCase) e os
// snapshots lidos server-side (RLS) para hidratar os formularios.
// =====================================================================

/** Estado de conexao da fonte (fontes.estado_conexao). */
export type EstadoConexao = "conectada" | "erro" | "nao_configurada";

/** Frequencias suportadas (espelha _shared/validation.ts FREQUENCIAS). */
export type Frequencia = "manual" | "horaria" | "diaria" | "semanal" | "mensal";

/**
 * Snapshot da fonte Effecti lido server-side (RLS) para hidratar o cmp-cred-form.
 * NUNCA inclui o segredo: `configurado` deriva apenas da presenca da referencia
 * no Vault (token_cifrado != null); o token real jamais trafega ao cliente
 * (RNF-02). `ultimaVerificacao` vem de fontes.updated_at.
 */
export interface FonteEffectiState {
  /** id da fonte (public.fontes.id); base do filtro de coleta em andamento. */
  id: string | null;
  nome: string;
  tipo: string;
  endpointBase: string;
  estadoConexao: EstadoConexao;
  configurado: boolean;
  ultimaVerificacao: string | null;
}

/** Snapshot da config de ingestao lido server-side para hidratar o cmp-cfg-form. */
export interface ConfigIngestaoState {
  janelaDias: number;
  modalidades: string[];
  portais: string[];
}

/**
 * Snapshot do agendamento POR FONTE (mora na config_ingestao da fonte) lido
 * server-side para hidratar o cmp-agendamento-fonte-form dentro do card da
 * fonte. Cada fonte tem seu proprio relogio (job pg_cron coleta-<tipo>);
 * substitui o ciclo GLOBAL (decisao 09/06). `horarioReferencia` e 'HH:MM'
 * local (America/Sao_Paulo, UTC-3).
 */
export interface AgendamentoFonteState {
  fonte: FonteTipo;
  /**
   * Recurso/modulo quando o agendamento e POR MODULO (ex.: Nomus/processos,
   * mora em config_ingestao.recursos.<recurso>.agendamento). Ausente/null no
   * agendamento POR FONTE (Effecti/Gmail, colunas top-level).
   */
  recurso?: string | null;
  ativo: boolean;
  frequencia: Frequencia;
  horarioReferencia: string | null;
  diaSemana: number | null;
  diaMes: number | null;
}

/** Estrategia de OCR da camada 1 (mapeia no Tika): auto/nunca/sempre. */
export type OcrEstrategia = "auto" | "nunca" | "sempre";

/** Fontes que o extrator sabe obter bytes (adaptadores do runner). */
export type FonteExtracao = "nomus" | "effecti" | "drive" | "gmail";

/**
 * Snapshot dos parametros da camada 1 do extrator (singleton config_extracao)
 * lido server-side para hidratar o cmp-extracao-config-form. O runner Node le
 * a mesma config no inicio do job; alterar aqui vale na PROXIMA execucao.
 * `extensoesHabilitadas` null = todas as extensoes; `fontesHabilitadas`
 * null = todas as fontes (so as listadas entram na fila de extracao).
 */
export interface ConfigExtracaoState {
  ocrEstrategia: OcrEstrategia;
  ocrIdioma: string;
  tamanhoMaxBytes: number;
  timeoutMs: number;
  extensoesHabilitadas: string[] | null;
  fontesHabilitadas: FonteExtracao[] | null;
  loteTamanho: number;
  pausaLoteMs: number;
}

/**
 * Snapshot do agendamento da EXTRACAO (camada 1), lido server-side para
 * hidratar o cmp-agendamento-extracao-form. Mora nas colunas de agendamento do
 * singleton config_extracao e materializa o job pg_cron 'extrair-anexos' (que
 * dispara o workflow extrair-anexos.yml). O extrator e GLOBAL (drena a fila
 * inteira), por isso nao ha fonte/recurso. `horarioReferencia` e 'HH:MM' local.
 */
export interface AgendamentoExtracaoState {
  ativo: boolean;
  frequencia: Frequencia;
  horarioReferencia: string | null;
  diaSemana: number | null;
  diaMes: number | null;
}

/** Fontes cujos documentos podem ser indexados (mesmo universo da extracao). */
export type FonteIndexacao = FonteExtracao;

/**
 * Snapshot da config da INDEXACAO (embeddings) — singleton config_indexacao,
 * lido server-side para hidratar o cmp-indexacao-config-form. `ativo` = master
 * switch (gasta na OpenAI quando ON); `fontesHabilitadas` null = todas as
 * fontes; `loteChunks` = orcamento de chunks por invocacao do backfill;
 * `pausaMs` = pausa entre documentos. Vale na PROXIMA invocacao.
 */
export interface ConfigIndexacaoState {
  ativo: boolean;
  /**
   * Master switch da perna de PROCESSOS (nomus_processos.descricao -> RAG).
   * Independente de `ativo` (que governa os documentos); ON gasta na OpenAI.
   */
  processosAtivo: boolean;
  fontesHabilitadas: FonteIndexacao[] | null;
  loteChunks: number;
  pausaMs: number;
  /** Teto de tokens/min mirado ao chamar a OpenAI (pacer; 0 = sem pacing). */
  tpmAlvo: number;
  /** Teto de tentativas antes de marcar a indexacao como 'erro' definitivo. */
  tentativasMax: number;
}

/** Contagem de documentos indexaveis por status (foto da fila de indexacao). */
export interface IndexacaoResumo {
  pendente: number;
  emAndamento: number;
  concluida: number;
  erro: number;
  total: number;
}

/**
 * Pasta do Google Drive cadastrada no cockpit (tabela drive_pastas), lida
 * server-side para hidratar o cmp-drive-pastas-form. O runner descobre as
 * ATIVAS no inicio do job de extracao. `id` identifica a linha (remover);
 * `folderId` e o id natural da pasta no Drive.
 */
export interface DrivePastaState {
  id: string;
  folderId: string;
  nome: string;
  ativo: boolean;
  updatedAt: string | null;
}

/**
 * Conta Google conectada ao Drive (singleton drive_conta), lida server-side
 * para o cmp-drive-card. O refresh_token vive cifrado no Vault — aqui so o
 * e-mail e quando conectou. `conectado` deriva da presenca do e-mail.
 */
export interface DriveContaState {
  conectado: boolean;
  email: string | null;
  conectadoEm: string | null;
}

/**
 * Conta Google conectada ao Gmail (singleton gmail_conta), lida server-side
 * para o cmp-gmail-card. INDEPENDENTE do Drive (refresh_token proprio no
 * Vault). `conectado` deriva da presenca do e-mail.
 */
export interface GmailContaState {
  conectado: boolean;
  email: string | null;
  conectadoEm: string | null;
}

/** Slugs das guias (categorias) do Gmail a EXCLUIR; viram -category:<slug>. */
export type CategoriaGmail = "promotions" | "social" | "updates" | "forums";

/**
 * Config da coleta Gmail (singleton gmail_config), lida server-side para o
 * cmp-gmail-config-form. `dataInicial` ('YYYY-MM-DD') vira after:YYYY/MM/DD na
 * query; coleta so mensagens a partir dela.
 */
export interface GmailConfigState {
  dataInicial: string | null;
  /**
   * Slugs de categoria do Gmail a EXCLUIR (promotions/social/updates/forums).
   * As guias do Gmail nao sao labels comuns; viram -category:<slug> na query.
   */
  categoriasExcluidas: CategoriaGmail[];
}

/**
 * Label da BLACKLIST do Gmail (tabela gmail_labels), lida server-side para o
 * cmp-gmail-config-form. Decisao Fabio 2026-06-09: cadastram-se labels a
 * EXCLUIR (vira -label:"nome" na query), nao a incluir. `id` identifica a
 * linha (remover); `label` e o nome da label no Gmail; `ativo` liga/desliga a
 * exclusao sem apagar.
 */
export interface GmailLabelState {
  id: string;
  label: string;
  nome: string;
  ativo: boolean;
  updatedAt: string | null;
}

/** PUT /fontes/effecti/credencial -> nunca retorna o segredo (RNF-02). */
export interface SalvarCredencialResponse {
  ok: boolean;
}

/** Causa especifica de falha do teste de conexao (copy distinta por causa). */
export type TestFailureCause = "timeout" | "unauthorized" | "rate_limited" | "unknown";

/**
 * POST /fontes/effecti/testar -> estado da conexao + latencia medida.
 * Em falha de teste o backend responde 200 com estadoConexao='erro' e
 * acompanha `causa`/`mensagem` para a UI exibir a copy correta.
 */
export interface TestarConexaoResponse {
  estadoConexao: EstadoConexao;
  latenciaMs: number;
  causa?: TestFailureCause;
  mensagem?: string;
}

/** PUT /ingestao/config -> confirmacao de persistencia. */
export interface SalvarConfigResponse {
  ok: boolean;
}

/**
 * PUT /agendamento/config -> confirma a persistencia e devolve o texto
 * resultante de aplicar_agendamento() (ex.: "agendado: 0 10 * * * (UTC)
 * freq=diaria" ou "ciclo desligado").
 */
export interface SalvarAgendamentoResponse {
  ok: boolean;
  agendamento: string | null;
}

/** Um resultado da busca semantica /v1: aviso resolvido + similaridade. */
export interface BuscaSemanticaResultItem {
  /** Id do aviso (avisos.id) ao qual o chunk mais similar pertence. */
  id: string;
  /** Similaridade de cosseno (1 - distancia); maior = mais relevante. */
  score: number;
  /** Conteudo verbatim integro do aviso (avisos.conteudo_verbatim). */
  verbatim: string;
}

/** POST /v1/substrato/busca-semantica -> top-K por similaridade de cosseno. */
export interface BuscaSemanticaResponse {
  results: BuscaSemanticaResultItem[];
}

// =====================================================================
// Fontes parametrizadas por tipo (Effecti | Nomus) — bloco Nomus na tela
// de Fontes. Espelham os contratos das Edge Functions (sprint-003/004):
// fontes-credencial, fontes-testar, ingestao-config e ingestao-coletar.
// Payloads viajam em snake_case; aqui o front trabalha em camelCase.
// =====================================================================

/**
 * Tipo de fonte suportado. Credencial/teste/config (cmp-cred-form/cmp-cfg-form)
 * valem para effecti|nomus; o Gmail e o Drive entram como fontes AGENDAVEIS
 * (relogio proprio no card, coleta no GitHub Actions via coletar-gmail.yml /
 * coletar-drive.yml) — autenticam por OAuth e configuram via gmail-config /
 * drive-pastas, nao pelos forms de credencial.
 */
export type FonteTipo = "effecti" | "nomus" | "gmail" | "drive";

/**
 * Snapshot de credencial de uma fonte (hidratado server-side via RLS) para o
 * cmp-cred-form. Reaproveita a forma do Effecti: NUNCA inclui o segredo;
 * `configurado` deriva apenas da presenca da referencia no Vault (RNF-02).
 */
export type FonteCredState = FonteEffectiState;

/**
 * Linha resumida de public.fontes consumida pelo cmp-fonte-saude (useFontes).
 * Leitura direta da tabela via RLS do usuario autorizado (sem segredo).
 */
export interface Fonte {
  id: string;
  tipo: FonteTipo;
  estadoConexao: EstadoConexao;
  ativa: boolean;
  ordem: number;
  ultimaColetaEm: string | null;
}

/** Alias do contrato do teste de conexao (POST fontes-testar). */
export type TesteConexao = TestarConexaoResponse;

/**
 * Config por recurso (config_ingestao.recursos.<recurso>) em camelCase.
 * Governa o toggle de recurso e os tipos ativos por recurso (US-04/US-05).
 */
export interface RecursoConfig {
  ativo: boolean;
  tiposAtivos: string[];
  usaFiltroDataAlteracao?: boolean;
  etapasTerminais?: string[];
  /** Janela por recurso: corte por nomus_id (ex.: processos a partir de 25000). */
  idInicial?: number | null;
  /** Janela por recurso: corte por data de criacao 'YYYY-MM-DD'. */
  dataInicial?: string | null;
  /** Janela deslizante (retencao) em dias deste recurso; null = sem janela. */
  janelaDias?: number | null;
}

/** GET ingestao-config?fonte= -> config corrente da fonte (camelCase). */
export interface IngestaoConfig {
  fonte: FonteTipo;
  janelaDias: number | null;
  /** data_inicial GLOBAL (top-level): fallback legado; a janela vive por recurso. */
  dataInicial: string | null;
  recursos: Record<string, RecursoConfig>;
}

/**
 * POST ingestao-coletar (Nomus) -> execucao criada (202) ou single-flight.
 * `jaEmAndamento` acompanha o 409 (ja existe coleta corrente).
 */
export interface ColetarResponse {
  execucaoId: string;
  estado: "em_andamento";
  jaEmAndamento?: boolean;
}

/** Modo do disparo manual da coleta Nomus (workflow_dispatch). */
export type NomusModo = "incremental" | "full";

/**
 * POST nomus-disparar -> aciona o workflow do GitHub Actions (202). A coleta
 * roda assincrona no runner (TLS legado); `requestId` e o id da requisicao
 * pg_net (telemetria), nao a execucao em si.
 */
export interface DispararNomusResponse {
  ok: boolean;
  modo: NomusModo;
  requestId: number | null;
}

/**
 * POST gmail-disparar -> aciona o workflow coletar-gmail.yml no GitHub Actions
 * (202). A coleta roda assincrona no runner (a janela vem do gmail-config).
 * `requestId` e o id da requisicao pg_net (telemetria).
 */
export interface DispararGmailResponse {
  ok: boolean;
  requestId: number | null;
}

/**
 * POST extracao-disparar -> aciona o workflow extrair-anexos.yml no GitHub
 * Actions (202). Descobre os anexos das pastas Drive ativas e drena a fila de
 * documentos (Tika), assincrono no runner. `requestId` e o id da requisicao
 * pg_net (telemetria).
 */
export interface DispararExtracaoResponse {
  ok: boolean;
  requestId: number | null;
}

/**
 * POST ocr-disparar -> aciona o workflow extrair-ocr.yml no GitHub Actions
 * (202). Drena a fila de documentos com status precisa_ocr (escaneados/imagem)
 * com OCR ligado, assincrono no runner. `requestId` e o id da requisicao
 * pg_net (telemetria).
 */
export interface DispararOcrResponse {
  ok: boolean;
  requestId: number | null;
}

/**
 * POST drive-disparar -> aciona o workflow coletar-drive.yml no GitHub Actions
 * (202). Descobre as pastas Drive ativas e enfileira os vinculos na fila de
 * documentos (sem Tika), assincrono no runner. `requestId` e o id da requisicao
 * pg_net (telemetria).
 */
export interface DispararDriveResponse {
  ok: boolean;
  requestId: number | null;
}

// =====================================================================
// Modulo Produtos — tipos do contrato das Edge Functions produtos-* (secao
// 4.5 da SPEC). Nomes em PascalCase; campos em snake_case espelhando o JSON
// cru do backend (a UI NAO faz snake->camel neste dominio: o banco e a fonte
// de verdade e os formularios/telas consomem os mesmos nomes das colunas).
// Esta camada NAO consome /v1 (exclusivo da Lia).
// =====================================================================

// --- Enums de dominio (espelham os CHECKs do schema de produtos) ---
/** Tipo de um atributo de Linha (produto_linha_atributos.tipo). */
export type AtributoTipo = "texto" | "numero" | "booleano";
/** Origem do SKU: fabricado (BOM) ou comprado (custo de aquisicao). */
export type SkuTipoOrigem = "fabricado" | "comprado";
/** Unidade do tempo de lote do SKU (convertida para horas na derivacao). */
export type SkuUnidadeTempo = "hora" | "dia";
/** Estado do calculo de preco do SKU/linha de preco. */
export type EstadoCalculo = "vigente" | "pendente" | "erro";
/** Categoria do insumo (insumos.categoria). */
export type InsumoCategoria = "MP" | "embalagem" | "insumo";
/** Nivel de heranca dos parametros de calculo (global -> linha -> produto). */
export type ParametroNivel = "global" | "linha" | "produto";
/** Regiao do vetor regional / grid de precos. */
export type Regiao = "S" | "SE" | "CO" | "NE" | "N";
/**
 * Patamar de preco (metodo IFP / markup por dentro):
 *   FOB        — IFP sem frete (independe de regiao)
 *   CIF_MINIMO — IFP com frete + lucro minimo (piso de negociacao)
 *   CIF_ALVO   — IFP com frete + lucro alvo
 */
export type Patamar = "FOB" | "CIF_MINIMO" | "CIF_ALVO";
/** Nivel das diretrizes/regras/politica de cotacao (linha, produto ou sku). */
export type CotacaoNivel = "linha" | "produto" | "sku";
/** Tipo de regra estruturada de cotacao (cotacao_regras.tipo_regra). */
export type CotacaoTipoRegra = "faixa" | "opcional" | "substituicao";
/** Decisao de participacao em licitacao (politica_participacao.participa). */
export type PoliticaParticipa = "sim" | "nao" | "condicional";

/** Envelope paginado padrao das listagens de produtos (?limit=&offset=). */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------
// Dominio A — Linhas, Atributos, Produtos, SKUs e Imagens
// ---------------------------------------------------------------------

/** Linha/segmento de produto (produto_linhas). nome e a chave natural. */
export interface ProdutoLinha {
  id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  /** Produto cuja 1a foto representa a Linha; null = automatico (1o produto por nome). */
  produto_capa_id?: string | null;
  /** Foto representativa da Linha (capa escolhida, ou 1a imagem de um Produto da Linha; signed URL TTL 1h). */
  foto_url?: string | null;
  created_at: string;
  updated_at: string;
}

/** Atributo valido de uma Linha (produto_linha_atributos). */
export interface LinhaAtributo {
  id: string;
  linha_id: string;
  chave: string;
  tipo: AtributoTipo;
  obrigatorio: boolean;
  /** Visibilidade nos documentos imprimiveis (Catalogo / Ficha tecnica). */
  mostra_catalogo: boolean;
  mostra_ficha: boolean;
  created_at: string;
  updated_at: string;
}

/** Atributo PROPRIO de um Produto (produto_atributos). */
export interface ProdutoAtributo {
  id: string;
  produto_id: string;
  chave: string;
  tipo: AtributoTipo;
  obrigatorio: boolean;
  /** Visibilidade nos documentos imprimiveis (Catalogo / Ficha tecnica). */
  mostra_catalogo: boolean;
  mostra_ficha: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Subconjunto do atributo exposto no detalhe do produto (atributos_schema).
 * origem discrimina a procedencia: 'linha' (herdado) ou 'produto' (proprio).
 */
export interface AtributoSchema {
  chave: string;
  tipo: AtributoTipo;
  obrigatorio: boolean;
  origem: "linha" | "produto";
  mostra_catalogo: boolean;
  mostra_ficha: boolean;
}

/** Produto/Familia vinculado a uma Linha (produtos). atributos e JSONB livre. */
export interface Produto {
  id: string;
  linha_id: string;
  nome: string;
  descricao: string | null;
  atributos: Record<string, unknown>;
  prazo_entrega: string | null;
  disponibilidade: string | null;
  pedido_minimo: string | null;
  ativo: boolean;
  /** Foto do Produto (1a imagem propria por ordem; signed URL TTL 1h). */
  foto_url?: string | null;
  created_at: string;
  updated_at: string;
}

/** Variante/SKU de um Produto (produto_skus). */
export interface ProdutoSku {
  id: string;
  produto_id: string;
  codigo_sku: string;
  tipo_origem: SkuTipoOrigem;
  atributos: Record<string, unknown>;
  dimensoes: Record<string, unknown> | null;
  tolerancia_pct: number | null;
  acabamento: string | null;
  peso_gr: number | null;
  diretriz_producao: string | null;
  /** Lote de producao (so fabricado): qtd de unidades por lote. */
  tamanho_lote: number | null;
  /** Tempo do lote inteiro, na unidade `unidade_tempo`. */
  tempo_lote: number | null;
  /** Unidade do tempo do lote (convertida para horas na derivacao). */
  unidade_tempo: SkuUnidadeTempo | null;
  /** Derivado do lote (read-only): tempo_lote em horas / tamanho_lote. */
  tempo_producao: number | null;
  estado_calculo: EstadoCalculo;
  ativo: boolean;
  /** Foto do SKU (1a imagem propria por ordem; signed URL TTL 1h). */
  foto_url?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Foto de Produto e/ou SKU (produto_imagens). `signed_url` so vem na listagem
 * (URL assinada temporaria, TTL 1h); `created_at`/`updated_at` so no detalhe.
 */
export interface ProdutoImagem {
  id: string;
  produto_id: string | null;
  sku_id: string | null;
  storage_path: string;
  signed_url?: string | null;
  ordem: number;
  legenda: string | null;
  created_at?: string;
  updated_at?: string;
}

/** GET /produtos-catalogo/produtos/:id — detalhe agregado do produto. */
export interface ProdutoDetalhe {
  produto: Produto;
  atributos_schema: AtributoSchema[];
  skus: ProdutoSku[];
  imagens: ProdutoImagem[];
}

/**
 * Atributo (Linha ou Produto) como vem nos dados de documentos: chave/tipo +
 * flags de visibilidade. Sem ids — so o necessario para montar o documento.
 */
export interface DocAtributo {
  chave: string;
  tipo: AtributoTipo;
  obrigatorio: boolean;
  mostra_catalogo: boolean;
  mostra_ficha: boolean;
}

/** SKU de uma Linha nos dados de documentos (valores + foto, sem preco). */
export interface DocumentoSku {
  id: string;
  codigo_sku: string;
  tipo_origem: SkuTipoOrigem;
  atributos: Record<string, unknown>;
  dimensoes: Record<string, unknown> | null;
  acabamento: string | null;
  peso_gr: number | null;
  tolerancia_pct: number | null;
  /** URL assinada (TTL 1h) da foto do SKU; null se nao houver. */
  foto_url: string | null;
}

/** Produto de uma Linha nos dados de documentos (valores + foto + SKUs). */
export interface DocumentoProduto {
  id: string;
  nome: string;
  descricao: string | null;
  /** Valores dos atributos da Linha (uniforme por produto). */
  atributos: Record<string, unknown>;
  prazo_entrega: string | null;
  disponibilidade: string | null;
  pedido_minimo: string | null;
  /** URL assinada (TTL 1h) da foto do produto; null se nao houver. */
  foto_url: string | null;
  /** Atributos PROPRIOS do produto (preenchidos por SKU). */
  atributos_produto: DocAtributo[];
  skus: DocumentoSku[];
}

/** GET /produtos-catalogo/documentos-dados?linha_id= — dados p/ Catalogo e Ficha. */
export interface DocumentoLinhaDados {
  linha: { id: string; nome: string };
  /** Schema de atributos da Linha (com flags de visibilidade). */
  atributos_linha: DocAtributo[];
  produtos: DocumentoProduto[];
}

// ---------------------------------------------------------------------
// Dominio B — Insumos, precos de fornecedor, composicao (BOM) e custo
// de aquisicao. As escritas disparam o recalculo SINCRONO dos SKUs no
// backend (triggers); a UI apenas invalida os caches de precos.
// ---------------------------------------------------------------------

/** Insumo / materia-prima (insumos). */
export interface Insumo {
  id: string;
  nome: string;
  categoria: InsumoCategoria;
  unidade: string;
  ativo: boolean;
  created_at: string;
  updated_at: string;
}

/** Faixa de preco de fornecedor de um insumo, com vigencia (insumo_precos). */
export interface InsumoPreco {
  id: string;
  insumo_id: string;
  fornecedor: string | null;
  preco: number;
  vigencia_inicio: string;
  vigencia_fim: string | null;
  created_at: string;
  updated_at: string;
}

/** Item da BOM de um SKU fabricado (sku_composicao). */
export interface SkuComposicaoItem {
  id: string;
  sku_id: string;
  insumo_id: string;
  quantidade: number;
  unidade: string | null;
  /**
   * Quantas pecas 1 unidade de material rende. Quando preenchido,
   * quantidade = 1 / rendimento. Null = quantidade informada direto.
   */
  rendimento: number | null;
  created_at: string;
  updated_at: string;
}

/** Faixa de custo de aquisicao de um SKU comprado (sku_custo_aquisicao). */
export interface SkuCustoAquisicao {
  id: string;
  sku_id: string;
  fornecedor: string | null;
  custo: number;
  vigencia_inicio: string;
  vigencia_fim: string | null;
  created_at: string;
  updated_at: string;
}

/** Resultado do PUT /insumo-precos/batch (edicao em lote de precos). */
export interface InsumoPrecoBatchResponse {
  updated: number;
  skus_marcados_recalculo: number;
}

// ---------------------------------------------------------------------
// Dominio C — Parametros de calculo e precos calculados
// ---------------------------------------------------------------------

/** Parametros escalares por nivel/escopo (parametros_calculo). */
export interface ParametrosCalculo {
  id: string;
  nivel: ParametroNivel;
  escopo_id: string | null;
  impostos_pct: number | null;
  frete_pct: number | null;
  despesas_pct: number | null;
  lucro_pct: number | null;
  lucro_minimo_pct: number | null;
  taxa_horaria: number | null;
  /** Jornada (horas/dia) p/ converter lote em "dia"; so usada no nivel global. */
  horas_por_dia: number | null;
  created_at: string;
  updated_at: string;
}

/** Uma regiao do vetor regional por nivel/escopo (parametro_regional). */
export interface ParametroRegional {
  id: string;
  nivel: ParametroNivel;
  escopo_id: string | null;
  regiao: Regiao;
  percentual: number | null;
  created_at: string;
  updated_at: string;
}

/** Campos escalares resolviveis dos parametros de calculo. */
export type ParametroEscalarCampo =
  | "impostos_pct"
  | "frete_pct"
  | "despesas_pct"
  | "lucro_pct"
  | "lucro_minimo_pct"
  | "taxa_horaria";

/** Valor efetivo de um parametro + a origem (nivel) de onde foi herdado. */
export interface ParametroResolvidoEscalar {
  valor: number | null;
  origem: ParametroNivel;
}

/** Valor efetivo de uma regiao + a origem (nivel) de onde foi herdada. */
export interface ParametroResolvidoRegiao {
  percentual: number | null;
  origem: ParametroNivel;
}

/**
 * GET /parametros-resolvidos?produto_id= — valor EFETIVO de cada parametro
 * escalar e de cada regiao para um Produto, indicando a origem (PRODUTO ->
 * LINHA -> GLOBAL).
 */
export interface ParametrosResolvidos {
  escalares: Record<ParametroEscalarCampo, ParametroResolvidoEscalar>;
  regional: Record<Regiao, ParametroResolvidoRegiao>;
}

/**
 * Uma celula do grid de precos (regiao x patamar) — campos de exibicao.
 * `ifp` e o indice (1 - somatorio de percentuais) usado no calculo daquela
 * celula; e exclusivo do motor (varia por patamar/regiao) e somente leitura.
 */
export interface PrecoCalculadoLinha {
  regiao: Regiao;
  patamar: Patamar;
  valor: number | null;
  ifp: number | null;
  estado: EstadoCalculo;
  calculado_em: string | null;
}

/**
 * Indicadores de apoio do SKU (sku_precos_calculados), os UNICOS campos
 * gravaveis pela UI; valor/custo_base/ifp sao exclusivos do motor (RF-23).
 */
export interface PrecoApoio {
  preco_concorrencia: number | null;
  custo_ideal: number | null;
}

/** GET /skus/:skuId/precos — grid (regiao x patamar) + estado + apoio. */
export interface PrecoCalculadoGrid {
  estado_calculo: EstadoCalculo;
  precos: PrecoCalculadoLinha[];
  apoio: PrecoApoio;
  custo_base: number | null;
}

/** Item de GET /precos/pendentes — SKU pendente/erro de recalculo. */
export interface PrecoPendente {
  sku_id: string;
  codigo_sku: string;
  estado_calculo: EstadoCalculo;
}

/**
 * Celula da tabela consolidada (regiao x patamar) de um SKU. Subconjunto de
 * PrecoCalculadoLinha (sem calculado_em): valor + ifp por celula, somente
 * leitura (motor).
 */
export interface TabelaPrecoCelula {
  regiao: Regiao;
  patamar: Patamar;
  valor: number | null;
  ifp: number | null;
  estado: EstadoCalculo;
}

/** Um SKU na tabela consolidada da Linha, com suas celulas de preco. */
export interface TabelaPrecoSku {
  sku_id: string;
  codigo_sku: string;
  estado_calculo: EstadoCalculo;
  precos: TabelaPrecoCelula[];
}

/** Um Produto na tabela consolidada da Linha, agrupando seus SKUs. */
export interface TabelaPrecoProduto {
  produto_id: string;
  nome: string;
  /** Lucro alvo (LL%) efetivo do produto, resolvido produto->linha->global. */
  lucro_pct: number | null;
  /** URL assinada da primeira imagem do produto (TTL curto); null se sem foto. */
  foto_url: string | null;
  skus: TabelaPrecoSku[];
}

/**
 * GET /precos/consolidado?linha_id= — Tabela de Preços de uma Linha inteira:
 * todos os Produtos -> SKUs -> celulas (regiao x patamar) num so payload.
 * Leitura em lote no edge; somente leitura.
 */
export interface TabelaPrecoConsolidada {
  linha_id: string;
  produtos: TabelaPrecoProduto[];
}

/**
 * config_empresa — dados institucionais da DLH (singleton) usados no
 * cabecalho/rodape da Tabela de Precos em PDF. Contrato camelCase. A logo e
 * uma data URL base64 de imagem (sem bucket de Storage).
 */
export interface ConfigEmpresa {
  razaoSocial: string | null;
  nomeFantasia: string | null;
  cnpj: string | null;
  inscricaoEstadual: string | null;
  endereco: string | null;
  telefone: string | null;
  email: string | null;
  site: string | null;
  logoBase64: string | null;
  validadePadraoDias: number;
  observacaoRodape: string | null;
}

/**
 * config_llm — configuracao da IA (LLM) das geracoes assistidas do cockpit
 * (singleton). A chave da API NUNCA trafega no contrato; key_configurada
 * apenas sinaliza se ha segredo gravado no Vault.
 */
export interface ConfigLlm {
  provider: "openai";
  modelo: string;
  ativo: boolean;
  descricaoMaxPalavras: number;
  key_configurada: boolean;
}

/** Payload de gravacao da config de IA. apiKey opcional (so quando trocar). */
export interface ConfigLlmInput {
  provider: "openai";
  modelo: string;
  ativo: boolean;
  descricaoMaxPalavras: number;
  apiKey?: string;
}

/**
 * config_busca — configuracao do RERANKING da busca semantica do acervo
 * (singleton). A chave da Cohere NUNCA trafega no contrato; key_configurada
 * apenas sinaliza se ha segredo gravado no Vault.
 */
export interface ConfigBusca {
  rerankAtivo: boolean;
  rerankModelo: string;
  rerankCandidatos: number;
  hibridaAtiva: boolean;
  hibridaCandidatosLexical: number;
  key_configurada: boolean;
}

/** Payload de gravacao da config de busca. apiKey opcional (so ao trocar). */
export interface ConfigBuscaInput {
  rerankAtivo: boolean;
  rerankModelo: string;
  rerankCandidatos: number;
  hibridaAtiva: boolean;
  hibridaCandidatosLexical: number;
  apiKey?: string;
}

// ---------------------------------------------------------------------
// Dominio E — Diretrizes/regras de cotacao e politica de participacao
// ---------------------------------------------------------------------

/** Diretriz textual de cotacao por LINHA/PRODUTO (cotacao_diretrizes). */
export interface CotacaoDiretriz {
  id: string;
  nivel: CotacaoNivel;
  escopo_id: string;
  texto: string;
  created_at: string;
  updated_at: string;
}

/** Regra estruturada de cotacao por atributo (cotacao_regras). */
export interface CotacaoRegra {
  id: string;
  nivel: CotacaoNivel;
  escopo_id: string;
  atributo: string;
  tipo_regra: CotacaoTipoRegra;
  valor_min: number | null;
  valor_max: number | null;
  substituicao: string | null;
  created_at: string;
  updated_at: string;
}

/** Politica de participacao em licitacao (politica_participacao). */
export interface PoliticaParticipacao {
  id: string;
  nivel: CotacaoNivel;
  escopo_id: string;
  participa: PoliticaParticipa;
  condicao: string | null;
  diretriz_texto: string | null;
  preferencia: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------
// Dominio D — Revenda (canal SEPARADO do de licitacao)
// ---------------------------------------------------------------------

/** Cliente do canal de revenda (clientes_revenda). */
export interface ClienteRevenda {
  id: string;
  nome: string;
  ativo: boolean;
  created_at: string;
  updated_at: string;
}

/** Faixa de preco de revenda por cliente/SKU, com vigencia (revenda_precos). */
export interface RevendaPreco {
  id: string;
  cliente_id: string;
  sku_id: string;
  preco: number;
  vigencia_inicio: string;
  vigencia_fim: string | null;
  created_at: string;
  updated_at: string;
}

// =====================================================================
// Modulo Automacao (triagem) — contrato 4.3. camelCase no client, mapeado
// do snake_case dos endpoints automacao-* (ver src/lib/api/automacao.ts).
// SSE/realtime NAO usado no V1 (FE-3): atualizacao por refetchInterval +
// botao manual. O frontend NUNCA manipula credenciais write:triagem/lia_sk_.
// =====================================================================

/** Veredito da triagem (classificacao deterministica server-side). */
export type Veredito = "lixo" | "duvida" | "util";

/** Rotulo do feedback humano sobre a decisao vigente. */
export type FeedbackHumano = "correto" | "incorreto";

/** Item da fila de triagem (aviso ja triado), exposto na aba Triagem. */
export interface TriagemItem {
  avisoId: string;
  effectiId: string | null;
  /** Numero do edital/pregao (payload_bruto->>processo). */
  edital: string | null;
  portal: string | null;
  uasg: string | null;
  objeto: string;
  orgao: string;
  uf: string;
  /** ISO8601 da abertura dos lances (data_final). */
  data: string;
  veredito: Veredito | null;
  /** Confianca crua em [0,1]; null quando ausente. */
  confianca: number | null;
  motivo: string | null;
  produtoCandidato: string | null;
  feedbackHumano: FeedbackHumano | null;
  naLixeira: boolean;
  naLixeiraEm: string | null;
  descartePrevistoEm: string | null;
  reabilitado: boolean;
}

/** Item da lixeira: mesma forma da triagem (filtro lixeira aplicado no servidor). */
export type LixeiraItem = TriagemItem;

/** Estado da extracao de itens de um documento (recall por item). */
export type ItensStatus =
  | "pendente"
  | "extraido"
  | "sem_itens"
  | "erro"
  | "inobtenivel"
  | "ignorado";

/** Documento vinculado a um aviso + estado da extracao de itens (lazy). */
export interface AvisoDocumento {
  documentoId: string;
  nomeArquivo: string | null;
  itensStatus: ItensStatus;
}

/** Item literal extraido de um documento de edital (descricao integral). */
export interface AvisoItem {
  documentoId: string;
  /** Rotulo da lista de origem (ex.: 'principal', 'anexo TR'); listas convivem. */
  listaOrigem: string;
  /** 'tecnica' (descricao confiavel) ou 'portal' (generica, nao confiavel). */
  fonteDescricao: string;
  itemNumero: string | null;
  lote: string | null;
  descricao: string;
  unidade: string | null;
  quantidade: number | null;
  /** Preco de referencia UNITARIO (nullable). */
  precoReferencia: number | null;
  ordem: number | null;
}

/** Itens extraidos de um aviso (documentos + itens por documento). */
export interface AvisoItens {
  documentos: AvisoDocumento[];
  itens: AvisoItem[];
}

/** Regra dura editavel, consumida deterministicamente pela triagem (E5). */
export interface RegraDura {
  id: string;
  tipo: "fora_de_ramo" | "termo_produto";
  termo: string;
  ativo: boolean;
  criadoEm: string;
}

/** Exemplo rotulado do acervo few-shot (E14 — curadoria do aprendizado). */
export interface ExemploFewShot {
  id: string;
  texto: string;
  vereditoRotulado: Veredito;
  ativo: boolean;
  avisoId: string | null;
  decisaoId: string | null;
  criadoEm: string;
}

/** Config singleton da automacao (carencia, limiares, K, interruptor). */
export interface AutomacaoConfig {
  diasCarencia: number;
  limiarInferior: number;
  limiarSuperior: number;
  kFewShot: number;
  descarteFisicoLigado: boolean;
  triarApenasFuturos: boolean;
  triagemHorizonteDias: number;
  modoExecucaoIa: "lion" | "autonoma";
  atualizadoEm: string;
}

/** Persona/prompt versionada do subagente especialista (E15, server-side). */
export interface AgenteConfig {
  ativo: boolean;
  nome: string;
  personaPrompt: string;
  ferramentas: string[];
  versao: number;
  atualizadoEm: string;
}

/** Amostra de falso-descarte: aviso que virou processo real no Nomus mas foi marcado lixo. */
export interface FalsoDescarteAmostra {
  avisoId: string;
  objeto: string;
  veredito: Veredito;
  confianca: number | null;
  nomusProcessoRef: string;
}

/** Resultado do backtest de recall em modo sombra (gate do descarte fisico). */
export interface BacktestRecall {
  periodo: { desde: string; ate: string };
  processosNomusReais: number;
  casadosComAviso: number;
  preservadosPelaTriagem: number;
  descartadosIndevidamente: number;
  /** null quando o Nomus esta indisponivel (502). */
  recall: number | null;
  descarteFisicoLigado: boolean;
  amostrasFalsoDescarte: FalsoDescarteAmostra[];
}
