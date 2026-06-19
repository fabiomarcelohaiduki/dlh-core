import {
  Bot,
  Boxes,
  CheckCircle2,
  ChevronDown,
  Database,
  FileText,
  Gavel,
  HelpCircle,
  Inbox,
  ListChecks,
  ScanText,
  ShieldCheck,
  Trash2,
  UserCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * FluxoClient — aba "Como funciona". Diagrama explicativo (estatico, sem fetch)
 * do fluxo RECALL POR ITEM da triagem: das reflexos 24/7 (coleta/extracao/
 * indexacao deterministicas) ate a decisao (classificacao por limiares +
 * validacao humana). Reaproveita o vocabulario do design lock (.card/.tag/
 * .section-title/.helper + tokens de estado) sem cor nova. Documenta a
 * fronteira SOM: a IA sugere por item, o humano valida e posta.
 */

type Tone = "reflexo" | "ia" | "decisao";

const TONE: Record<Tone, { line: string; chip: string; chipBg: string }> = {
  reflexo: { line: "var(--run)", chip: "var(--run)", chipBg: "var(--run-bg)" },
  ia: { line: "var(--accent)", chip: "var(--accent)", chipBg: "var(--accent-soft)" },
  decisao: { line: "var(--ok)", chip: "var(--ok)", chipBg: "var(--ok-bg)" },
};

function Connector({ tone }: { tone: Tone }) {
  return (
    <div
      aria-hidden="true"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        padding: "2px 0",
      }}
    >
      <span style={{ width: 2, height: 14, background: TONE[tone].line, opacity: 0.5 }} />
      <ChevronDown size={16} style={{ color: TONE[tone].line, opacity: 0.7 }} />
    </div>
  );
}

function Step({
  tone,
  icon: Icon,
  step,
  title,
  desc,
  badge,
}: {
  tone: Tone;
  icon: LucideIcon;
  step: number;
  title: string;
  desc: string;
  badge?: { label: string; cls?: string };
}) {
  return (
    <div
      className="card"
      style={{
        display: "flex",
        gap: 14,
        alignItems: "flex-start",
        padding: 16,
        borderLeft: `3px solid ${TONE[tone].line}`,
        width: "100%",
        maxWidth: 560,
      }}
    >
      <span
        style={{
          flex: "0 0 auto",
          width: 38,
          height: 38,
          borderRadius: "var(--r-md)",
          display: "grid",
          placeItems: "center",
          color: TONE[tone].chip,
          background: TONE[tone].chipBg,
          border: `1px solid ${TONE[tone].line}`,
        }}
      >
        <Icon size={20} aria-hidden="true" />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--muted)",
              flex: "0 0 auto",
            }}
          >
            {String(step).padStart(2, "0")}
          </span>
          <strong style={{ fontSize: 14, color: "var(--fg)" }}>{title}</strong>
          {badge && (
            <span className={badge.cls ? `tag ${badge.cls}` : "tag"} style={{ marginLeft: "auto" }}>
              {badge.label}
            </span>
          )}
        </div>
        <p className="helper" style={{ margin: 0 }}>
          {desc}
        </p>
      </div>
    </div>
  );
}

function PhaseLabel({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.2,
        color: TONE[tone].chip,
        background: TONE[tone].chipBg,
        border: `1px solid ${TONE[tone].line}`,
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

const VEREDITOS: { cls: string; icon: LucideIcon; label: string; desc: string }[] = [
  {
    cls: "util",
    icon: CheckCircle2,
    label: "Útil",
    desc: "Tem produto da DLH. Favorita na Effecti para o time avaliar a proposta.",
  },
  {
    cls: "duvida",
    icon: HelpCircle,
    label: "Dúvida",
    desc: "Sinal ambíguo. Fica para revisão humana antes de favoritar ou descartar.",
  },
  {
    cls: "lixo",
    icon: Trash2,
    label: "Lixo",
    desc: "Fora do ramo. Vai para a lixeira (descarte em modo sombra, reversível).",
  },
];

export function FluxoClient() {
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Como funciona a triagem</h3>
      </div>
      <p className="helper" style={{ marginTop: 2, marginBottom: 20 }}>
        Fluxo RECALL POR ITEM: cada item do edital é cruzado contra o catálogo, não
        só o objeto. Os reflexos coletam e indexam 24/7 de forma determinística; a
        camada de IA analisa item a item quando ativa; a decisão é determinística por
        limiares e sempre passa por validação humana (modelo SOM).
      </p>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0 }}>
        {/* Fase 1 — Reflexos 24/7 */}
        <PhaseLabel tone="reflexo">
          <Database size={14} aria-hidden="true" /> Reflexos automáticos · 24/7 · determinístico
        </PhaseLabel>
        <Step
          tone="reflexo"
          icon={Inbox}
          step={1}
          title="Coleta de avisos"
          desc="Effecti e portais alimentam o Supabase continuamente. 1 linha por licitação; comunicados atualizam a mesma entidade."
        />
        <Connector tone="reflexo" />
        <Step
          tone="reflexo"
          icon={FileText}
          step={2}
          title="Extração de texto dos documentos"
          desc="Camada barata e ampla: extrai o texto dos anexos (dedup global por arquivo). Paga largo para nunca perder licitação."
        />
        <Connector tone="reflexo" />
        <Step
          tone="reflexo"
          icon={ScanText}
          step={3}
          title="Indexação (embeddings)"
          desc="Texto vira vetores para busca semântica. Sem gate: recall total é prioridade sobre custo."
        />
        <Connector tone="reflexo" />

        {/* Fila */}
        <Step
          tone="ia"
          icon={ListChecks}
          step={4}
          title="Fila de triagem"
          desc="O servidor monta o pacote do aviso: persona do agente (versionada), base de conhecimento do setor, itens já extraídos e documentos ainda pendentes."
        />
        <Connector tone="ia" />

        {/* Fase 2 — Camada IA */}
        <PhaseLabel tone="ia">
          <Bot size={14} aria-hidden="true" /> Análise por item · IA · com a Lia ativa
        </PhaseLabel>
        <Step
          tone="ia"
          icon={ListChecks}
          step={5}
          title="Extração por item"
          desc="Para cada documento pendente, a Lia lê o texto e grava TODOS os itens, íntegros e literais. Tudo-ou-nada: nunca parcial, nunca linha-resumo (recall total)."
        />
        <Connector tone="ia" />
        <Step
          tone="ia"
          icon={Boxes}
          step={6}
          title="Cruzamento com o catálogo"
          desc="Cada item é buscado por similaridade contra os SKUs da DLH (produtos_busca). Identifica linha e produto candidato."
        />
        <Connector tone="ia" />
        <Step
          tone="ia"
          icon={ShieldCheck}
          step={7}
          title="Política de participação"
          desc="Para os produtos identificados, consulta a política (determinística no banco). 'Não cotamos' = descarte determinístico, fora da decisão da IA."
        />
        <Connector tone="ia" />
        <Step
          tone="ia"
          icon={Bot}
          step={8}
          title="Recomendação de relevância"
          desc="A IA reporta a probabilidade de o aviso ter produto DLH [0–1] e sugere o veredito. Nunca posta nem favorita: apenas sugere (fronteira SOM)."
          badge={{ label: "IA sugere" }}
        />
        <Connector tone="decisao" />

        {/* Fase 3 — Decisão */}
        <PhaseLabel tone="decisao">
          <Gavel size={14} aria-hidden="true" /> Decisão · determinística + humana
        </PhaseLabel>
        <Step
          tone="decisao"
          icon={Gavel}
          step={9}
          title="Classificação por limiares"
          desc="O servidor classifica a relevância pelos limiares (inferior / superior). Regra crítica é determinística no banco, nunca na IA."
        />
        <Connector tone="decisao" />

        {/* Vereditos */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))",
            gap: 12,
            width: "100%",
            maxWidth: 560,
          }}
        >
          {VEREDITOS.map((v) => {
            const Icon = v.icon;
            return (
              <div
                key={v.cls}
                className="card"
                style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}
              >
                <span className={`tag ${v.cls}`} style={{ alignSelf: "flex-start", gap: 6 }}>
                  <Icon size={13} aria-hidden="true" /> {v.label}
                </span>
                <p className="helper" style={{ margin: 0 }}>
                  {v.desc}
                </p>
              </div>
            );
          })}
        </div>
        <Connector tone="decisao" />

        {/* Validação humana */}
        <Step
          tone="decisao"
          icon={UserCheck}
          step={10}
          title="Validação humana"
          desc="A Lia revisa a sugestão e posta o veredito. Decisões sensíveis (participar, preço-limite, assinatura) ficam com o humano. A IA elimina o operacional; o humano valida nos pontos-chave."
          badge={{ label: "humano valida", cls: "util" }}
        />
      </div>
    </>
  );
}
