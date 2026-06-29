"use client";

import type { ReactNode } from "react";
import { Factory, Gavel, HardDrive, ListPlus, Mail, ScanText } from "lucide-react";
import { AgendamentoFonteForm } from "@/components/cockpit/agendamento-fonte-form";
import { AgendamentoExtracaoForm } from "@/components/cockpit/agendamento-extracao-form";
import { AgendamentoDescobertaNomusForm } from "@/components/cockpit/agendamento-descoberta-nomus-form";
import { CfgAccordion } from "@/components/cockpit/config/cfg-accordion";
import { StatusPill } from "@/components/cockpit/status-pill";
import type { AgendamentosColetaData } from "@/lib/fontes-credenciais-data";
import type { AgendamentoExtracaoState, AgendamentoFonteState } from "@/lib/api/types";

/**
 * cmp-agendamento-coleta — guia Agendamento do submodulo Coleta.
 *
 * Reune SO a cadencia da coleta automatica de cada fonte (Effecti, Nomus
 * Processos, Nomus Pessoas, Gmail, Drive). Saiu das Integracoes, onde ficavam
 * misturados com credenciais, disparo manual e filtros — estes seguem la. Cada
 * card edita um relogio independente (AgendamentoFonteForm grava o pg_cron da
 * fonte/recurso via PUT /agendamento-fonte-config).
 *
 * Pos-migracao 28/06 (saida do GitHub Actions): so Supabase Edge + PC local.
 * Effecti/Gmail/Drive rodam pelo pg_cron -> Edge nativa. Nomus roda no PC local
 * (so fala TLS CBC legado que a Edge nao conecta), mas o cockpit volta a ser
 * dono do relogio: o pg_cron de Nomus, na hora marcada, ENFILEIRA o comando na
 * fila comando_local e o servico de poll do PC executa. Por isso TODOS os cards
 * (inclusive Nomus) editam a cadencia aqui via AgendamentoFonteForm.
 *
 * Alem das fontes, ha o card "Extracao": o relogio global da extracao (Tika/OCR)
 * que drena a fila de anexos pendentes. Saiu do drawer "Parametros" da guia Fila
 * de extracao (nao fazia sentido um agendamento dentro de parametros) e passou a
 * morar aqui, junto dos demais agendamentos. Usa AgendamentoExtracaoForm.
 *
 * E o card "Enfileiramento · Nomus": o relogio da DESCOBERTA do Nomus. Effecti
 * auto-descobre pos-coleta e Gmail/Drive entregam a lista pronta — so o Nomus
 * dependia do botao manual "Trazer para a fila". Na hora marcada, o pg_cron
 * 'descobrir-nomus' chama a Edge documentos-descobrir (server-side, sem PC) e
 * materializa os anexos pendentes na fila de extracao. Usa
 * AgendamentoDescobertaNomusForm; o botao manual segue como atalho.
 */

interface FonteAgendamento {
  id: string;
  icon: ReactNode;
  nome: string;
  nota: string;
  agendamento: AgendamentoFonteState;
}

const ICON_STYLE = { width: 17, height: 17 } as const;

export function AgendamentoColeta({
  effecti,
  effectiJanelaDias,
  nomusProcessos,
  nomusPessoas,
  nomusProcessosFull,
  gmail,
  drive,
  extracao,
  descobertaNomus,
}: AgendamentosColetaData & {
  extracao: AgendamentoExtracaoState;
  descobertaNomus: AgendamentoExtracaoState;
}) {
  const fontes: FonteAgendamento[] = [
    {
      id: "effecti",
      icon: <Gavel aria-hidden="true" style={ICON_STYLE} />,
      nome: "Effecti",
      nota: `A cada execução re-varre os últimos ${effectiJanelaDias} dias e ingere avisos novos; atualiza os que mudaram.`,
      agendamento: effecti,
    },
    {
      id: "nomus-processos",
      icon: <Factory aria-hidden="true" style={ICON_STYLE} />,
      nome: "Nomus · Processos",
      nota: "Coleta incremental de processos novos desde a última coleta. Roda no PC local; o cockpit enfileira na hora marcada.",
      agendamento: nomusProcessos,
    },
    {
      id: "nomus-pessoas",
      icon: <Factory aria-hidden="true" style={ICON_STYLE} />,
      nome: "Nomus · Pessoas",
      nota: "Coleta incremental de pessoas novas e edições desde a última coleta. Roda no PC local; o cockpit enfileira na hora marcada.",
      agendamento: nomusPessoas,
    },
    {
      id: "nomus-processos-full",
      icon: <Factory aria-hidden="true" style={ICON_STYLE} />,
      nome: "Nomus · Processos (re-varredura full)",
      nota: "Re-varre os processos dentro do corte de idade para pegar mudanças de etapa que a coleta incremental por id nunca revê. Roda no PC local; o cockpit enfileira na hora marcada.",
      agendamento: nomusProcessosFull,
    },
    {
      id: "gmail",
      icon: <Mail aria-hidden="true" style={ICON_STYLE} />,
      nome: "Gmail",
      nota: "A cada execução busca os e-mails novos desde a última coleta e enfileira corpo e anexos.",
      agendamento: gmail,
    },
    {
      id: "drive",
      icon: <HardDrive aria-hidden="true" style={ICON_STYLE} />,
      nome: "Google Drive",
      nota: "A cada execução re-lista as pastas ativas e enfileira arquivos novos e editados para extração.",
      agendamento: drive,
    },
  ];

  return (
    <CfgAccordion>
      {fontes.map((f) => (
        <section
          key={f.id}
          className="cfg-panel-card"
          aria-labelledby={`agendamento-${f.id}-h`}
        >
          <div className="panel-header">
            <div
              className="panel-title"
              style={{ display: "flex", alignItems: "center", gap: 12 }}
            >
              <span
                className="avatar"
                style={{
                  borderRadius: 9,
                  width: 34,
                  height: 34,
                  color: "var(--accent)",
                  background: "var(--accent-soft)",
                  borderColor: "var(--accent-line)",
                }}
              >
                {f.icon}
              </span>
              <div>
                <h3 id={`agendamento-${f.id}-h`}>{f.nome}</h3>
                <p>{f.nota}</p>
              </div>
            </div>
            <StatusPill
              state={f.agendamento.ativo ? "ok" : "idle"}
              label={f.agendamento.ativo ? "Ativa" : "Pausada"}
            />
          </div>
          <div className="cfg-panel-body">
            <AgendamentoFonteForm initial={f.agendamento} />
          </div>
        </section>
      ))}

      <section
        className="cfg-panel-card"
        aria-labelledby="agendamento-extracao-h"
      >
        <div className="panel-header">
          <div
            className="panel-title"
            style={{ display: "flex", alignItems: "center", gap: 12 }}
          >
            <span
              className="avatar"
              style={{
                borderRadius: 9,
                width: 34,
                height: 34,
                color: "var(--accent)",
                background: "var(--accent-soft)",
                borderColor: "var(--accent-line)",
              }}
            >
              <ScanText aria-hidden="true" style={ICON_STYLE} />
            </span>
            <div>
              <h3 id="agendamento-extracao-h">Extração</h3>
              <p>
                Na hora marcada, drena a fila de extração: roda Tika e OCR nos anexos
                pendentes de todas as fontes. Roda no PC local; o cockpit enfileira o comando.
              </p>
            </div>
          </div>
          <StatusPill
            state={extracao.ativo ? "ok" : "idle"}
            label={extracao.ativo ? "Ativa" : "Pausada"}
          />
        </div>
        <div className="cfg-panel-body">
          <AgendamentoExtracaoForm initial={extracao} />
        </div>
      </section>

      <section
        className="cfg-panel-card"
        aria-labelledby="agendamento-descoberta-nomus-h"
      >
        <div className="panel-header">
          <div
            className="panel-title"
            style={{ display: "flex", alignItems: "center", gap: 12 }}
          >
            <span
              className="avatar"
              style={{
                borderRadius: 9,
                width: 34,
                height: 34,
                color: "var(--accent)",
                background: "var(--accent-soft)",
                borderColor: "var(--accent-line)",
              }}
            >
              <ListPlus aria-hidden="true" style={ICON_STYLE} />
            </span>
            <div>
              <h3 id="agendamento-descoberta-nomus-h">Enfileiramento · Nomus</h3>
              <p>
                Na hora marcada, descobre os anexos do Nomus e os enfileira na fila de
                extração. Roda no servidor (sem PC); o botão manual “Trazer para a fila”
                segue como atalho.
              </p>
            </div>
          </div>
          <StatusPill
            state={descobertaNomus.ativo ? "ok" : "idle"}
            label={descobertaNomus.ativo ? "Ativa" : "Pausada"}
          />
        </div>
        <div className="cfg-panel-body">
          <AgendamentoDescobertaNomusForm initial={descobertaNomus} />
        </div>
      </section>
    </CfgAccordion>
  );
}
