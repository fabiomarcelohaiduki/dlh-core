import { createClient } from "@/lib/supabase/server";
import type {
  AgendamentoFonteState,
  CategoriaGmail,
  ConfigIngestaoState,
  DriveContaState,
  DrivePastaState,
  EstadoConexao,
  FonteCredState,
  FonteEffectiState,
  Frequencia,
  GmailConfigState,
  GmailContaState,
  GmailLabelState,
} from "@/lib/api/types";

/**
 * Hidratacao server-side (RLS) de todas as fontes de ingestao (Effecti, Nomus,
 * Drive, Gmail) para o painel editavel FontesCredenciais. Reune as leituras das
 * credenciais, configs, agendamentos e contas Google numa unica chamada.
 *
 * Vive em Integracoes (/integracoes-global). Nenhum segredo trafega ao cliente:
 * os booleanos `configurado`/`conectado` derivam apenas da presenca da
 * referencia no Vault (RNF-02).
 */

const FREQUENCIAS: ReadonlySet<Frequencia> = new Set([
  "manual",
  "horaria",
  "diaria",
  "semanal",
  "mensal",
]);

/** Linha lida de public.fontes (apenas a referencia/booleano, nunca o segredo). */
interface FonteRow {
  id: string | null;
  nome: string | null;
  tipo: string | null;
  endpoint_base: string | null;
  estado_conexao: string | null;
  token_cifrado: string | null;
  painel_cred_em: string | null;
  updated_at: string | null;
}

/** Linha lida de public.config_ingestao (filtros e janela vigentes da fonte). */
interface ConfigRow {
  janela_dias: number | null;
  modalidades: string[] | null;
  portais: string[] | null;
}

/** Linha lida de public.config_ingestao (agendamento POR FONTE). */
interface AgendamentoFonteRow {
  agendamento_ativo: boolean | null;
  frequencia: string | null;
  horario_referencia: string | null;
  dia_semana: number | null;
  dia_mes: number | null;
}

/** Agendamento POR MODULO guardado em config_ingestao.recursos.<recurso>.agendamento. */
interface AgendamentoRecursoJson {
  ativo?: boolean | null;
  frequencia?: string | null;
  horario_referencia?: string | null;
  dia_semana?: number | null;
  dia_mes?: number | null;
}

function normalizeFrequencia(value: string | null): Frequencia {
  return value && FREQUENCIAS.has(value as Frequencia) ? (value as Frequencia) : "manual";
}

/**
 * Hidratacao server-side (RLS) da fonte Effecti para o cmp-cred-form.
 * Le apenas a presenca da referencia do Vault (token_cifrado != null) para
 * derivar `configurado`; o token real jamais trafega ao cliente (RNF-02).
 */
async function loadFonte(): Promise<FonteEffectiState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("fontes")
    .select(
      "id, nome, tipo, endpoint_base, estado_conexao, token_cifrado, painel_cred_em, updated_at",
    )
    .eq("tipo", "effecti")
    .maybeSingle();

  const data = (raw ?? null) as FonteRow | null;

  return {
    id: data?.id ?? null,
    nome: data?.nome ?? "Effecti",
    tipo: data?.tipo ?? "effecti",
    endpointBase: data?.endpoint_base ?? "—",
    estadoConexao: (data?.estado_conexao as EstadoConexao) ?? "nao_configurada",
    configurado: Boolean(data?.token_cifrado),
    painelConfigurado: Boolean(data?.painel_cred_em),
    ultimaVerificacao: data?.updated_at ?? null,
  };
}

/**
 * Hidratacao server-side (RLS) da fonte Nomus para o cmp-cred-form do bloco
 * Nomus. Mesma regra de seguranca do Effecti: `configurado` deriva apenas da
 * presenca da referencia no Vault; o segredo jamais trafega ao cliente (RNF-02).
 */
async function loadFonteNomus(): Promise<FonteCredState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("fontes")
    .select("id, nome, tipo, endpoint_base, estado_conexao, token_cifrado, updated_at")
    .eq("tipo", "nomus")
    .maybeSingle();

  const data = (raw ?? null) as FonteRow | null;

  return {
    id: data?.id ?? null,
    nome: data?.nome ?? "Nomus",
    tipo: data?.tipo ?? "nomus",
    endpointBase: data?.endpoint_base ?? "—",
    estadoConexao: (data?.estado_conexao as EstadoConexao) ?? "nao_configurada",
    configurado: Boolean(data?.token_cifrado),
    // Nomus nao tem painel web programatico; a flag fica sempre falsa.
    painelConfigurado: false,
    ultimaVerificacao: data?.updated_at ?? null,
  };
}

/**
 * Id da fonte Gmail (public.fontes tipo=gmail) para o cmp-gmail-disparo-form
 * detectar coleta em andamento desta fonte (mesmo filtro por fonte_id de
 * Effecti/Nomus). Sem linha cai em null e o aviso simplesmente nao aparece.
 */
async function loadFonteGmailId(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("fontes")
    .select("id")
    .eq("tipo", "gmail")
    .maybeSingle();

  return (data?.id as string | undefined) ?? null;
}

/**
 * Hidratacao server-side (RLS) da config de ingestao vigente da fonte Effecti
 * para o cmp-cfg-form (apenas janela + filtros). Sem config (1o acesso) cai no
 * default (janela 15). Frequencia/horario vivem no agendamento POR FONTE.
 */
async function loadConfig(): Promise<ConfigIngestaoState> {
  const supabase = await createClient();

  const { data: fonteRaw } = await supabase
    .from("fontes")
    .select("id")
    .eq("tipo", "effecti")
    .maybeSingle();

  const fonteRef = (fonteRaw ?? null) as { id: string } | null;

  const { data: configRaw } = fonteRef
    ? await supabase
        .from("config_ingestao")
        .select("janela_dias, modalidades, portais")
        .eq("fonte_id", fonteRef.id)
        .maybeSingle()
    : { data: null };

  const data = (configRaw ?? null) as ConfigRow | null;

  return {
    janelaDias: data?.janela_dias ?? 15,
    modalidades: data?.modalidades ?? [],
    portais: data?.portais ?? [],
  };
}

/**
 * Hidratacao server-side (RLS) do agendamento POR FONTE (mora na
 * config_ingestao da fonte) para o cmp-agendamento-fonte-form dentro do card
 * da fonte. Serve Effecti e Nomus (relogio identico; o destino do disparo —
 * Edge ou GitHub Actions — e resolvido por aplicar_agendamento_fonte). Sem
 * config (1o acesso) cai no default desligado/manual.
 */
async function loadAgendamentoFonte(
  tipo: AgendamentoFonteState["fonte"],
  recurso?: string,
): Promise<AgendamentoFonteState> {
  const supabase = await createClient();

  const { data: fonteRaw } = await supabase
    .from("fontes")
    .select("id")
    .eq("tipo", tipo)
    .maybeSingle();

  const fonteRef = (fonteRaw ?? null) as { id: string } | null;

  // recurso presente => agendamento POR MODULO (jsonb recursos.<recurso>);
  // ausente => POR FONTE (colunas top-level, Effecti/Gmail).
  if (recurso) {
    const { data: raw } = fonteRef
      ? await supabase
          .from("config_ingestao")
          .select("recursos")
          .eq("fonte_id", fonteRef.id)
          .maybeSingle()
      : { data: null };

    const recursos = ((raw ?? null) as { recursos: Record<string, unknown> | null } | null)
      ?.recursos ?? null;
    const ag = ((recursos?.[recurso] ?? null) as { agendamento?: AgendamentoRecursoJson } | null)
      ?.agendamento ?? null;

    return {
      fonte: tipo,
      recurso,
      ativo: ag?.ativo ?? false,
      frequencia: normalizeFrequencia(ag?.frequencia ?? null),
      horarioReferencia: ag?.horario_referencia ?? null,
      diaSemana: ag?.dia_semana ?? null,
      diaMes: ag?.dia_mes ?? null,
    };
  }

  const { data: raw } = fonteRef
    ? await supabase
        .from("config_ingestao")
        .select("agendamento_ativo, frequencia, horario_referencia, dia_semana, dia_mes")
        .eq("fonte_id", fonteRef.id)
        .maybeSingle()
    : { data: null };

  const data = (raw ?? null) as AgendamentoFonteRow | null;

  return {
    fonte: tipo,
    ativo: data?.agendamento_ativo ?? false,
    frequencia: normalizeFrequencia(data?.frequencia ?? null),
    horarioReferencia: data?.horario_referencia ?? null,
    diaSemana: data?.dia_semana ?? null,
    diaMes: data?.dia_mes ?? null,
  };
}

/** Linha lida de public.drive_pastas (pastas do Drive cadastradas no cockpit). */
interface DrivePastaRow {
  id: string;
  folder_id: string | null;
  nome: string | null;
  ativo: boolean | null;
  updated_at: string | null;
}

/**
 * Hidratacao server-side (RLS) das pastas do Drive cadastradas para a
 * descoberta da camada 1 (tabela drive_pastas) — alimenta o cmp-drive-pastas-form.
 * As escritas (adicionar/pausar/remover) passam pelo Edge drive-pastas.
 */
async function loadDrivePastas(): Promise<DrivePastaState[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("drive_pastas")
    .select("id, folder_id, nome, ativo, updated_at")
    .order("created_at", { ascending: true });

  return ((data ?? []) as DrivePastaRow[]).map((r) => ({
    id: r.id,
    folderId: r.folder_id ?? "",
    nome: r.nome ?? "(sem nome)",
    ativo: r.ativo ?? false,
    updatedAt: r.updated_at ?? null,
  }));
}

/** Linha lida do singleton public.drive_conta (conta Google conectada). */
interface DriveContaRow {
  email: string | null;
  conectado_em: string | null;
}

/**
 * Hidratacao server-side (RLS) da conta Google conectada ao Drive (singleton
 * drive_conta) para o cmp-drive-card. O refresh_token vive cifrado no Vault;
 * aqui so o e-mail e quando conectou. `conectado` deriva do e-mail presente.
 */
async function loadDriveConta(): Promise<DriveContaState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("drive_conta")
    .select("email, conectado_em")
    .eq("id", true)
    .maybeSingle();

  const data = (raw ?? null) as DriveContaRow | null;
  return {
    conectado: Boolean(data?.email),
    email: data?.email ?? null,
    conectadoEm: data?.conectado_em ?? null,
  };
}

/** Linha lida do singleton public.gmail_conta (conta Google do Gmail). */
interface GmailContaRow {
  email: string | null;
  conectado_em: string | null;
}

/**
 * Hidratacao server-side (RLS) da conta Google conectada ao Gmail (singleton
 * gmail_conta) para o cmp-gmail-card. INDEPENDENTE do Drive (refresh_token
 * proprio no Vault); aqui so o e-mail e quando conectou.
 */
async function loadGmailConta(): Promise<GmailContaState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("gmail_conta")
    .select("email, conectado_em")
    .eq("id", true)
    .maybeSingle();

  const data = (raw ?? null) as GmailContaRow | null;
  return {
    conectado: Boolean(data?.email),
    email: data?.email ?? null,
    conectadoEm: data?.conectado_em ?? null,
  };
}

/** Linha lida do singleton public.gmail_config (data inicial + categorias). */
interface GmailConfigRow {
  data_inicial: string | null;
  categorias_excluidas: CategoriaGmail[] | null;
}

/**
 * Hidratacao server-side (RLS) da config da coleta Gmail (singleton
 * gmail_config) para o cmp-gmail-config-form. Sem linha cai em null (—).
 */
async function loadGmailConfig(): Promise<GmailConfigState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("gmail_config")
    .select("data_inicial, categorias_excluidas")
    .eq("id", true)
    .maybeSingle();

  const data = (raw ?? null) as GmailConfigRow | null;
  return {
    dataInicial: data?.data_inicial ?? null,
    categoriasExcluidas: data?.categorias_excluidas ?? [],
  };
}

/** Linha lida de public.gmail_labels (blacklist de labels do Gmail). */
interface GmailLabelRow {
  id: string;
  label: string | null;
  nome: string | null;
  ativo: boolean | null;
  updated_at: string | null;
}

/**
 * Hidratacao server-side (RLS) das labels da blacklist do Gmail (tabela
 * gmail_labels) para o cmp-gmail-config-form. As escritas passam pelo Edge
 * gmail-config (service_role + audit).
 */
async function loadGmailLabels(): Promise<GmailLabelState[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("gmail_labels")
    .select("id, label, nome, ativo, updated_at")
    .order("created_at", { ascending: true });

  return ((data ?? []) as GmailLabelRow[]).map((r) => ({
    id: r.id,
    label: r.label ?? "",
    nome: r.nome ?? r.label ?? "(sem nome)",
    ativo: r.ativo ?? false,
    updatedAt: r.updated_at ?? null,
  }));
}

/**
 * Props do painel FontesCredenciais (4 fontes de ingestao) em Integracoes.
 *
 * So o que pertence a CONEXAO da fonte: credenciais (token/OAuth) e o pill de
 * estado. O agendamento (cadencia da coleta automatica) e o ESCOPO da coleta
 * (filtros: janela, modalidades, portais, recursos, pastas, labels) sairam
 * daqui para as guias Agendamento e Escopo do submodulo Coleta. Drive e Gmail
 * mantem o agendamento porque o PILL do card deriva dele (Ativa/Pausada), e os
 * contadores (pastas/labels) seguem como resumo read-only do card.
 */
export interface FontesCredenciaisData {
  effecti: FonteEffectiState;
  gmailAgendamento: AgendamentoFonteState;
  driveAgendamento: AgendamentoFonteState;
  nomus: FonteCredState;
  drivePastas: DrivePastaState[];
  driveConta: DriveContaState;
  gmailConta: GmailContaState;
  gmailConfig: GmailConfigState;
  gmailLabels: GmailLabelState[];
  gmailFonteId: string | null;
}

/** Carrega em paralelo todo o estado das 4 fontes para o painel editavel. */
export async function loadFontesCredenciais(): Promise<FontesCredenciaisData> {
  const [
    effecti,
    gmailAgendamento,
    driveAgendamento,
    nomus,
    drivePastas,
    driveConta,
    gmailConta,
    gmailConfig,
    gmailLabels,
    gmailFonteId,
  ] = await Promise.all([
    loadFonte(),
    loadAgendamentoFonte("gmail"),
    loadAgendamentoFonte("drive"),
    loadFonteNomus(),
    loadDrivePastas(),
    loadDriveConta(),
    loadGmailConta(),
    loadGmailConfig(),
    loadGmailLabels(),
    loadFonteGmailId(),
  ]);

  return {
    effecti,
    gmailAgendamento,
    driveAgendamento,
    nomus,
    drivePastas,
    driveConta,
    gmailConta,
    gmailConfig,
    gmailLabels,
    gmailFonteId,
  };
}

/**
 * Escopo da coleta de cada fonte para a guia Escopo do submodulo Coleta. Reune
 * os filtros que definem O QUE entra na coleta (janela/modalidades/portais do
 * Effecti, recursos/tipos do Nomus, pastas do Drive, data/categorias/labels do
 * Gmail) mais o disparo manual de cada fonte. Saiu de Integracoes, onde ficava
 * misturado com as credenciais; estas seguem la. So referencias/ids e configs
 * (nenhum segredo) trafegam ao cliente.
 */
export interface EscopoColetaData {
  effectiId: string | null;
  effectiConfig: ConfigIngestaoState;
  nomusId: string | null;
  drivePastas: DrivePastaState[];
  gmailConfig: GmailConfigState;
  gmailLabels: GmailLabelState[];
  gmailFonteId: string | null;
}

/** Carrega em paralelo o escopo de coleta das 4 fontes para a guia Escopo. */
export async function loadEscopoColeta(): Promise<EscopoColetaData> {
  const [effecti, effectiConfig, nomus, drivePastas, gmailConfig, gmailLabels, gmailFonteId] =
    await Promise.all([
      loadFonte(),
      loadConfig(),
      loadFonteNomus(),
      loadDrivePastas(),
      loadGmailConfig(),
      loadGmailLabels(),
      loadFonteGmailId(),
    ]);

  return {
    effectiId: effecti.id,
    effectiConfig,
    nomusId: nomus.id,
    drivePastas,
    gmailConfig,
    gmailLabels,
    gmailFonteId,
  };
}

/**
 * Estado dos agendamentos de COLETA das fontes (Effecti, Nomus Processos, Nomus
 * Pessoas, Gmail, Drive) para a guia Agendamento do submodulo Coleta. So a
 * cadencia da coleta automatica; credenciais, disparo manual e filtros seguem
 * em Integracoes. `effectiJanelaDias` alimenta a nota da fonte Effecti.
 */
export interface AgendamentosColetaData {
  effecti: AgendamentoFonteState;
  effectiJanelaDias: number;
  nomusProcessos: AgendamentoFonteState;
  nomusPessoas: AgendamentoFonteState;
  gmail: AgendamentoFonteState;
  drive: AgendamentoFonteState;
}

/** Carrega em paralelo os 5 agendamentos de coleta para a guia Agendamento. */
export async function loadAgendamentosColeta(): Promise<AgendamentosColetaData> {
  const [effecti, effectiConfig, nomusProcessos, nomusPessoas, gmail, drive] =
    await Promise.all([
      loadAgendamentoFonte("effecti"),
      loadConfig(),
      loadAgendamentoFonte("nomus", "processos"),
      loadAgendamentoFonte("nomus", "pessoas"),
      loadAgendamentoFonte("gmail"),
      loadAgendamentoFonte("drive"),
    ]);

  return {
    effecti,
    effectiJanelaDias: effectiConfig.janelaDias,
    nomusProcessos,
    nomusPessoas,
    gmail,
    drive,
  };
}
