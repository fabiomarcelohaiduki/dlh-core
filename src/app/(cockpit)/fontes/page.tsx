import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { FontesCredenciais } from "@/components/cockpit/fontes-credenciais";
import { AgendamentoForm } from "@/components/cockpit/agendamento-form";
import type {
  AgendamentoState,
  ConfigIngestaoState,
  DriveContaState,
  DrivePastaState,
  EstadoConexao,
  FonteCredState,
  FonteEffectiState,
  Frequencia,
} from "@/lib/api/types";

export const metadata: Metadata = { title: "Fontes e credenciais" };

const FREQUENCIAS: ReadonlySet<Frequencia> = new Set([
  "manual",
  "horaria",
  "diaria",
  "semanal",
  "mensal",
]);

/** Linha lida de public.fontes (apenas a referencia/booleano, nunca o segredo). */
interface FonteRow {
  nome: string | null;
  tipo: string | null;
  endpoint_base: string | null;
  estado_conexao: string | null;
  token_cifrado: string | null;
  updated_at: string | null;
}

/** Linha lida de public.config_ingestao (filtros e janela vigentes da fonte). */
interface ConfigRow {
  janela_dias: number | null;
  modalidades: string[] | null;
  portais: string[] | null;
}

/** Linha lida de public.config_agendamento (agendamento GLOBAL do ciclo). */
interface AgendamentoRow {
  ativo: boolean | null;
  frequencia: string | null;
  horario_referencia: string | null;
  dia_semana: number | null;
  dia_mes: number | null;
  timezone: string | null;
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
    .select("nome, tipo, endpoint_base, estado_conexao, token_cifrado, updated_at")
    .eq("tipo", "effecti")
    .maybeSingle();

  const data = (raw ?? null) as FonteRow | null;

  return {
    nome: data?.nome ?? "Effecti",
    tipo: data?.tipo ?? "effecti",
    endpointBase: data?.endpoint_base ?? "—",
    estadoConexao: (data?.estado_conexao as EstadoConexao) ?? "nao_configurada",
    configurado: Boolean(data?.token_cifrado),
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
    .select("nome, tipo, endpoint_base, estado_conexao, token_cifrado, updated_at")
    .eq("tipo", "nomus")
    .maybeSingle();

  const data = (raw ?? null) as FonteRow | null;

  return {
    nome: data?.nome ?? "Nomus",
    tipo: data?.tipo ?? "nomus",
    endpointBase: data?.endpoint_base ?? "—",
    estadoConexao: (data?.estado_conexao as EstadoConexao) ?? "nao_configurada",
    configurado: Boolean(data?.token_cifrado),
    ultimaVerificacao: data?.updated_at ?? null,
  };
}

/**
 * Hidratacao server-side (RLS) da config de ingestao vigente da fonte Effecti
 * para o cmp-cfg-form (apenas janela + filtros). Sem config (1o acesso) cai no
 * default (janela 15). Frequencia/horario migraram para o agendamento global.
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
 * Hidratacao server-side (RLS) do agendamento GLOBAL do ciclo (singleton
 * config_agendamento) para o cmp-agendamento-form. Sem linha (estado inicial)
 * cai no default desligado/manual.
 */
async function loadAgendamento(): Promise<AgendamentoState> {
  const supabase = await createClient();

  const { data: raw } = await supabase
    .from("config_agendamento")
    .select("ativo, frequencia, horario_referencia, dia_semana, dia_mes, timezone")
    .limit(1)
    .maybeSingle();

  const data = (raw ?? null) as AgendamentoRow | null;

  return {
    ativo: data?.ativo ?? false,
    frequencia: normalizeFrequencia(data?.frequencia ?? null),
    horarioReferencia: data?.horario_referencia ?? null,
    diaSemana: data?.dia_semana ?? null,
    diaMes: data?.dia_mes ?? null,
    timezone: data?.timezone ?? "America/Sao_Paulo",
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

export default async function FontesPage() {
  const [fonte, config, agendamento, fonteNomus, drivePastas, driveConta] =
    await Promise.all([
      loadFonte(),
      loadConfig(),
      loadAgendamento(),
      loadFonteNomus(),
      loadDrivePastas(),
      loadDriveConta(),
    ]);

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Fontes e credenciais</h2>
          <p>
            Gerencie as fontes de ingestão e suas credenciais sem editar código. As fontes ativas
            são o portal Effecti, o ERP Nomus e o Google Drive.
          </p>
        </div>
      </div>

      <AgendamentoForm initial={agendamento} />

      <FontesCredenciais
        effecti={fonte}
        effectiConfig={config}
        nomus={fonteNomus}
        drivePastas={drivePastas}
        driveConta={driveConta}
      />
    </section>
  );
}
