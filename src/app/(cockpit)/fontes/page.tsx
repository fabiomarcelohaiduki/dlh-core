import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { FonteEffectiBlock } from "@/components/cockpit/fonte-effecti-block";
import { FonteNomusBlock } from "@/components/cockpit/fonte-nomus-block";
import { AgendamentoForm } from "@/components/cockpit/agendamento-form";
import type {
  AgendamentoState,
  ConfigIngestaoState,
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

export default async function FontesPage() {
  const [fonte, config, agendamento, fonteNomus] = await Promise.all([
    loadFonte(),
    loadConfig(),
    loadAgendamento(),
    loadFonteNomus(),
  ]);

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Fontes e credenciais</h2>
          <p>
            Gerencie as fontes de ingestão e suas credenciais sem editar código. As fontes ativas
            são o portal Effecti e o ERP Nomus.
          </p>
        </div>
      </div>

      <AgendamentoForm initial={agendamento} />

      <FonteEffectiBlock fonte={fonte} config={config} />

      <FonteNomusBlock fonte={fonteNomus} />
    </section>
  );
}
