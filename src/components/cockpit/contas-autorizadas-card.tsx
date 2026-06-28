"use client";

// =====================================================================
// contas-autorizadas-card — gestao da allowlist de acesso (US-21).
//
// Lista, cria, liga/desliga e remove os e-mails e dominios que podem
// autenticar no cockpit (tabela contas_autorizadas, gate is_conta_autorizada).
// Toda escrita passa pela Edge `contas-autorizadas` (RLS + auditoria); a trava
// anti-lockout (nao deixar o solicitante se trancar para fora) vive no servidor
// e volta como 409 lockout_bloqueado, surfado aqui no feedback.
// =====================================================================

import { useState } from "react";
import { Globe, Loader2, Mail, Plus, Trash2, TriangleAlert } from "lucide-react";
import {
  useContasAutorizadas,
  useCriarContaAutorizada,
  useRemoverContaAutorizada,
  useToggleContaAutorizada,
} from "@/hooks/use-contas-autorizadas";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ContaAutorizada } from "@/lib/api/types";

type Tipo = "email" | "dominio";

/** Mensagem amigavel a partir de um erro de chamada a Edge. */
function mensagemErro(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  return fallback;
}

export function ContasAutorizadasCard() {
  const lista = useContasAutorizadas();
  const criar = useCriarContaAutorizada();
  const toggle = useToggleContaAutorizada();
  const remover = useRemoverContaAutorizada();

  const [tipo, setTipo] = useState<Tipo>("email");
  const [valor, setValor] = useState("");
  const [addErro, setAddErro] = useState<string | null>(null);
  const [acaoErro, setAcaoErro] = useState<string | null>(null);

  const contas = lista.data ?? [];

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddErro(null);
    setAcaoErro(null);
    const limpo = valor.trim().toLowerCase();
    if (!limpo) {
      setAddErro(tipo === "email" ? "Informe um e-mail." : "Informe um dominio.");
      return;
    }
    try {
      await criar.mutateAsync({ tipo, valor: limpo });
      setValor("");
    } catch (err) {
      setAddErro(
        mensagemErro(
          err,
          tipo === "email"
            ? "Nao foi possivel cadastrar o e-mail."
            : "Nao foi possivel cadastrar o dominio.",
        ),
      );
    }
  }

  async function handleToggle(conta: ContaAutorizada) {
    setAcaoErro(null);
    try {
      await toggle.mutateAsync({ id: conta.id, ativo: !conta.ativo });
    } catch (err) {
      setAcaoErro(mensagemErro(err, "Nao foi possivel alterar a conta."));
    }
  }

  async function handleRemove(conta: ContaAutorizada) {
    setAcaoErro(null);
    try {
      await remover.mutateAsync(conta.id);
    } catch (err) {
      setAcaoErro(mensagemErro(err, "Nao foi possivel remover a conta."));
    }
  }

  return (
    <section className="cfg-panel-card" aria-labelledby="contas-autorizadas-h">
      <div className="panel-header">
        <div className="panel-title">
          <h3 id="contas-autorizadas-h">Contas autorizadas</h3>
          <p>
            E-mails e dominios que podem autenticar com Google no cockpit. Quem
            nao consta aqui (ativo) e bloqueado no login.
          </p>
        </div>
        <span className="pill ok">{contas.length}</span>
      </div>

      <form className="allowlist-add" onSubmit={handleAdd} noValidate>
        <select
          aria-label="Tipo de autorizacao"
          value={tipo}
          onChange={(e) => {
            setTipo(e.target.value as Tipo);
            setAddErro(null);
          }}
        >
          <option value="email">E-mail</option>
          <option value="dominio">Dominio</option>
        </select>
        <input
          type="text"
          inputMode="email"
          aria-label={tipo === "email" ? "E-mail autorizado" : "Dominio autorizado"}
          placeholder={tipo === "email" ? "nome@dominio.com" : "dominio.com"}
          value={valor}
          onChange={(e) => {
            setValor(e.target.value);
            setAddErro(null);
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={criar.isPending}>
          {criar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" width={16} height={16} />
          ) : (
            <Plus aria-hidden="true" width={16} height={16} />
          )}
          <span>Adicionar</span>
        </button>
      </form>
      {addErro && (
        <div className="allowlist-feedback err" role="alert">
          <TriangleAlert aria-hidden="true" width={14} height={14} />
          {addErro}
        </div>
      )}

      {lista.isLoading ? (
        <div className="allowlist-empty">
          <Loader2 className="spin" aria-hidden="true" width={16} height={16} />
          Carregando contas...
        </div>
      ) : lista.isError ? (
        <div className="allowlist-feedback err" role="alert">
          <TriangleAlert aria-hidden="true" width={14} height={14} />
          Nao foi possivel carregar a lista de contas.
        </div>
      ) : contas.length === 0 ? (
        <div className="allowlist-empty">
          Nenhuma conta cadastrada. Adicione ao menos um e-mail ou dominio.
        </div>
      ) : (
        <ul className="stack-list">
          {contas.map((conta) => (
            <li
              key={conta.id}
              className={cn("stack-item", !conta.ativo && "is-off")}
            >
              <div className="stack-copy">
                <strong>{conta.valor}</strong>
                <span className="allowlist-tipo">
                  {conta.tipo === "email" ? (
                    <Mail aria-hidden="true" width={12} height={12} />
                  ) : (
                    <Globe aria-hidden="true" width={12} height={12} />
                  )}
                  {conta.tipo === "email" ? "E-mail" : "Dominio"}
                </span>
              </div>
              <div className="allowlist-actions">
                <button
                  type="button"
                  className={cn("pill", conta.ativo ? "ok" : "warn")}
                  onClick={() => handleToggle(conta)}
                  disabled={toggle.isPending}
                  aria-label={conta.ativo ? "Desativar conta" : "Ativar conta"}
                  title={conta.ativo ? "Clique para desativar" : "Clique para ativar"}
                >
                  <span className="dot" aria-hidden="true" />
                  {conta.ativo ? "Ativo" : "Inativo"}
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-danger"
                  onClick={() => handleRemove(conta)}
                  disabled={remover.isPending}
                  aria-label="Remover conta"
                  title="Remover conta"
                >
                  <Trash2 aria-hidden="true" width={15} height={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {acaoErro && (
        <div className="allowlist-feedback err" role="alert">
          <TriangleAlert aria-hidden="true" width={14} height={14} />
          {acaoErro}
        </div>
      )}
    </section>
  );
}
