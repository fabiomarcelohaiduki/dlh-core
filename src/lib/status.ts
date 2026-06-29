import { Ban, EyeOff, Link, ScanText, TriangleAlert, type LucideIcon } from "lucide-react";
import type {
  EstadoCalculo,
  EstadoConexao,
  Execucao,
  StatusIngestao,
} from "@/lib/api/types";
import type {
  StatusExtracao,
  StatusIndexacaoAgregado,
} from "@/lib/api/coleta-registros";

/**
 * Estados travados do Design Lock (convencao unica do projeto):
 *  ok   = sucesso / Saudavel
 *  run  = em andamento / processing
 *  warn = atencao / erros parciais
 *  err  = falha
 *  idle = nao configurado
 *
 * O mapeamento estado -> token de cor vive em cmp-status-pill (status-pill.tsx),
 * unica fonte de verdade visual. Aqui derivamos apenas o estado + rotulo a
 * partir dos enums de dominio do backend.
 */
export type PillState = "ok" | "run" | "warn" | "err" | "idle";

export interface PillDescriptor {
  state: PillState;
  label: string;
  /**
   * Icone Lucide opcional do pill (usado pelo descritor de status_extracao da
   * guia "Dados"). Os descritores legados nao definem icone (compativel).
   */
  icon?: LucideIcon;
}

/** Healthcheck: distingue warn (degradado) de err (parado). */
export function healthDescriptor(status: StatusIngestao): PillDescriptor {
  switch (status) {
    case "Saudavel":
      return { state: "ok", label: "Operacional" };
    case "Atencao":
      return { state: "warn", label: "Atenção" };
    case "Falha":
      return { state: "err", label: "Falha" };
    default:
      return { state: "idle", label: "Não configurado" };
  }
}

/** Texto auxiliar do card de healthcheck por estado. */
export function healthMeta(status: StatusIngestao): { tone: "up" | "warn" | "err"; text: string } {
  switch (status) {
    case "Saudavel":
      return { tone: "up", text: "Pipeline coleta → tratamento → indexação" };
    case "Atencao":
      return { tone: "warn", text: "Pipeline degradado · erros parciais na ingestão" };
    case "Falha":
    default:
      return { tone: "err", text: "Pipeline parado · intervenção necessária" };
  }
}

/**
 * Execucao: deriva o pill a partir de `status`. Toda execucao concluida e
 * sucesso -> verde, mesmo sem novos/alterados (re-coletar e nao achar novidade
 * e o caso normal, nao um aviso).
 */
export function execucaoDescriptor(execucao: Execucao): PillDescriptor {
  switch (execucao.status) {
    case "em_andamento":
      return { state: "run", label: "Em andamento" };
    case "erro":
      return { state: "err", label: "Com erro" };
    case "concluida":
      return { state: "ok", label: "Concluída" };
    default:
      return { state: "idle", label: execucao.status || "—" };
  }
}

/**
 * Origem normalizada das telas multi-origem (filtro Effecti x Nomus x Gmail).
 *  - execucoes.origem  = tipo da fonte ('effecti' | 'nomus' | 'gmail' | 'drive'); null (legado) = Effecti.
 *  - erros.origem      = 'aviso' (Effecti), 'processo-*'/'pessoa' (Nomus), 'gmail' ou 'drive'.
 */
export type OrigemKey = "effecti" | "nomus" | "gmail" | "drive";

/**
 * Teto de retomadas automaticas (NOMUS_MAX_RETOMADAS). Acima dele a retomada
 * passa a exigir acao manual ('Retomar'). Espelha o default do backend
 * (_shared/nomus-pipeline.ts: nomusMaxRetomadas()).
 */
export const NOMUS_MAX_RETOMADAS = 3;

/** Normaliza a origem crua (fonte/origem do erro) para a chave do filtro. */
export function normalizeOrigem(origem: string | null | undefined): OrigemKey {
  if (!origem) return "effecti";
  const o = origem.toLowerCase();
  if (o === "gmail") return "gmail";
  if (o === "drive") return "drive";
  if (o === "nomus" || o.startsWith("processo") || o.startsWith("pessoa")) return "nomus";
  if (o === "effecti" || o === "aviso") return "effecti";
  return "effecti";
}

/**
 * Onde a coleta da fonte EXECUTA na arquitetura atual (migracao 28/06, saida do
 * GitHub Actions): Effecti/Gmail/Drive rodam no Supabase Edge (pg_cron -> Edge
 * nativa); Nomus roda no PC local (Agendador do Windows -> coletar-nomus.mjs ->
 * push p/ a Edge nomus-ingerir), pois o Nomus so fala TLS CBC legado que o Deno
 * da Edge nao conecta. Derivado da ORIGEM — `execucoes` nao guarda o host por
 * linha; reflete o local canonico de cada fonte, nao um campo gravado.
 */
export function execucaoExecutor(origem: string | null | undefined): string {
  return normalizeOrigem(origem) === "nomus" ? "PC local" : "Supabase Edge";
}

/** Rotulo curto da origem para badges/filtros. */
export function origemLabel(key: OrigemKey): string {
  switch (key) {
    case "nomus":
      return "Nomus";
    case "gmail":
      return "Gmail";
    case "drive":
      return "Drive";
    default:
      return "Effecti";
  }
}

/**
 * True quando a execucao em erro esgotou as retomadas automaticas e aguarda
 * acao manual ('Retomar'): vale para as fontes coletadas em blocos com cursor
 * (Nomus e, desde 11/06, Effecti). O checkpoint de ambas traz fase e
 * tentativasRetomada; legados sem checkpoint nunca exibem a acao.
 */
export function precisaRetomadaManual(execucao: Execucao): boolean {
  if (execucao.status !== "erro") return false;
  const cp = execucao.checkpoint;
  if (!cp || cp.fase === "concluido") return false;
  return (cp.tentativasRetomada ?? 0) >= NOMUS_MAX_RETOMADAS;
}

/** Severidade do erro -> pill. */
export function severidadeDescriptor(severidade: string): PillDescriptor {
  switch (severidade.toLowerCase()) {
    case "alta":
      return { state: "err", label: "Alta" };
    case "media":
    case "média":
      return { state: "warn", label: "Média" };
    case "baixa":
    default:
      return { state: "idle", label: "Baixa" };
  }
}

/**
 * Estado do calculo de preco do SKU/linha (sku_precos_calculados.estado_calculo)
 * -> pill do grid de precos calculados (modulo Produtos, secao 4.6). Mapeamento
 * travado: vigente=ok, pendente=warn (recalculo pendente), erro=err (faltam
 * entradas essenciais). E a unica fonte do estado->cor do grid de precos.
 */
export function precoEstadoDescriptor(estado: EstadoCalculo): PillDescriptor {
  switch (estado) {
    case "vigente":
      return { state: "ok", label: "Vigente" };
    case "pendente":
      return { state: "warn", label: "Pendente" };
    case "erro":
      return { state: "err", label: "Erro" };
    default:
      return { state: "idle", label: "—" };
  }
}

/** Status de indexacao do aviso (avisos.status_indexacao) -> pill do edital. */
export function indexacaoDescriptor(status: string | null): PillDescriptor {
  switch (status) {
    case "indexado":
      return { state: "ok", label: "Indexado" };
    case "em_andamento":
      return { state: "run", label: "Indexando" };
    case "erro":
      return { state: "err", label: "Falha de indexação" };
    default:
      return { state: "idle", label: "Não indexado" };
  }
}

/**
 * True quando ha uma coleta em andamento PARA A FONTE informada (base do
 * anti-duplo-disparo). Filtra por `fonteId` — a chave inequivoca do lock
 * (o backend tranca por fonte_id). NAO usa `execucoes.origem`: na pratica
 * nenhuma fonte popula essa coluna (fica null tanto no Effecti quanto no
 * Nomus), entao comparar por origem dava falso negativo (Nomus nao travava)
 * e falso positivo (coleta do Nomus travava o botao do Effecti). Sem fonteId
 * (ainda hidratando) nao trava nada.
 *
 * `recurso` (opcional) ESTREITA o indicador ao recurso do card: o backend
 * tranca por (fonte_id, recurso) — processos e pessoas coletam em paralelo —
 * entao, sem este filtro, a coleta de um recurso acende o indicador do card
 * do outro (mesmo fonte_id). Omitido (Effecti/Gmail, recurso unico) mantem o
 * comportamento so-por-fonte.
 */
export function hasRunningExecucao(
  items: Execucao[] | undefined,
  fonteId: string | null | undefined,
  recurso?: string | null,
): boolean {
  if (!fonteId) return false;
  return Boolean(
    items?.some(
      (e) =>
        e.status === "em_andamento" &&
        e.fonteId === fonteId &&
        (recurso == null || e.recurso === recurso),
    ),
  );
}

/**
 * Estado de conexao da fonte (fontes.estado_conexao) -> pill do cmp-cred-form.
 * nao_configurada cai em `idle` (liga-se ao onboarding e ao estado vazio).
 */
export function conexaoDescriptor(estado: EstadoConexao): PillDescriptor {
  switch (estado) {
    case "conectada":
      return { state: "ok", label: "Conectada" };
    case "erro":
      return { state: "err", label: "Erro de conexão" };
    default:
      return { state: "idle", label: "Não configurada" };
  }
}

/** Estado de conexao por fonte para o indicador global do topbar. */
export interface FonteConexao {
  tipo: "effecti" | "nomus" | "drive" | "gmail";
  label: string;
  state: PillState;
}

/**
 * Cor da conexao no topbar. 'erro' explicito vence (vermelho); fonte conectada
 * — credencial presente (Effecti/Nomus) ou conta OAuth ligada (Drive/Gmail) —
 * fica verde; sem configuracao cai em cinza. Espelha a semantica do antigo
 * "Effecti · conectado" (configurada = conectada).
 */
export function conexaoFonteState(estado: string | null, conectado: boolean): PillState {
  if (estado === "erro") return "err";
  if (conectado) return "ok";
  return "idle";
}

/**
 * Status de extracao de UM vinculo (documento_vinculos.status_extracao) -> pill
 * da guia "Dados". Mapeamento travado da SPEC 4.5.2 (7 status_extracao -> 5
 * PillState), com rotulo e icone Lucide por estado. Reusa exclusivamente os 5
 * PillState existentes — sem novos tokens de cor:
 * Rotulos alinhados ao vocabulario da Fila de extracao (STATUS_LABEL em
 * extracao-fila-view.tsx) para nao confundir o usuario com nomes diferentes
 * para o mesmo status:
 *  pendente    -> idle  "Pendente"
 *  extraido    -> ok    "Extraido"
 *  herdado     -> ok    "Herdado"        (Link)
 *  precisa_ocr -> warn  "Aguardando OCR" (ScanText)
 *  erro        -> err   "Erro"           (TriangleAlert)
 *  inobtenivel -> err   "Inacessivel"    (Ban)
 *  ignorado    -> idle  "Ignorado"       (EyeOff)
 */
export function coletaStatusDescriptor(status: StatusExtracao): PillDescriptor {
  switch (status) {
    case "extraido":
      return { state: "ok", label: "Extraído" };
    case "herdado":
      return { state: "ok", label: "Herdado", icon: Link };
    case "precisa_ocr":
      return { state: "warn", label: "Aguardando OCR", icon: ScanText };
    case "erro":
      return { state: "err", label: "Erro", icon: TriangleAlert };
    case "inobtenivel":
      return { state: "err", label: "Inacessível", icon: Ban };
    case "ignorado":
      return { state: "idle", label: "Ignorado", icon: EyeOff };
    case "pendente":
    default:
      return { state: "idle", label: "Pendente" };
  }
}

/**
 * Estado AGREGADO de EXTRACAO de UM registro (linha mestra da guia "Dados",
 * status_indexacao_agregado) -> pill. O agregado e derivado do status_extracao
 * dos anexos (documento_vinculos), NAO de embeddings: por isso os rotulos falam
 * extracao/OCR, nao indexacao. Mapeamento travado da SPEC 4.5.3 (5 status
 * agregados -> 5 PillState), reusando exclusivamente os PillState existentes
 * (sem novos tokens de cor):
 * "Na fila" (em_andamento) reflete que ha anexos ainda AGUARDANDO extracao
 * (status pendente/precisa_ocr), nao um processamento ativo em curso — o
 * "Extraindo" anterior confundia. Reusa o PillState run, mesma cor do card
 * Pendentes da Fila de extracao.
 *  concluida      -> ok    "Extraído"
 *  em_andamento   -> run   "Na fila"
 *  erro           -> err   "Erro"
 *  mista          -> warn  "Parcial"
 *  sem_documentos -> idle  "Sem anexos"
 *  pendente       -> idle  "Pendente"
 */
export function indexacaoAgregadoDescriptor(
  status: StatusIndexacaoAgregado,
): PillDescriptor {
  switch (status) {
    case "concluida":
      return { state: "ok", label: "Extraído" };
    case "em_andamento":
      return { state: "run", label: "Na fila" };
    case "erro":
      return { state: "err", label: "Erro" };
    case "mista":
      return { state: "warn", label: "Parcial" };
    case "sem_documentos":
      return { state: "idle", label: "Sem anexos" };
    case "pendente":
    default:
      return { state: "idle", label: "Pendente" };
  }
}
