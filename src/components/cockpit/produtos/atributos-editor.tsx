"use client";

import { useState } from "react";
import { Loader2, Plus, TriangleAlert, Trash2 } from "lucide-react";
import {
  useCreateLinhaAtributo,
  useDeleteLinhaAtributo,
  useLinhaAtributos,
} from "@/hooks/use-linha-atributos";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { AtributoTipo, LinhaAtributo } from "@/lib/api/types";

const TIPOS: { value: AtributoTipo; label: string }[] = [
  { value: "texto", label: "Texto" },
  { value: "numero", label: "Número" },
  { value: "booleano", label: "Booleano" },
];

function tipoLabel(tipo: AtributoTipo): string {
  return TIPOS.find((t) => t.value === tipo)?.label ?? tipo;
}

/**
 * cmp-atributos-editor — define o conjunto de atributos de uma Linha como pares
 * chave/tipo/obrigatorio (produto_linha_atributos). E este schema que o
 * produto-form renderiza dinamicamente: criar/remover atributo aqui muda os
 * campos disponiveis em todos os Produtos da Linha. A chave e unica por Linha
 * (o backend rejeita duplicata com 409, exibido inline).
 *
 * `embedded`: renderiza como SECAO (sem o card proprio), para ficar DENTRO do
 * cadastro/detalhe da Linha em vez de um card irmao solto.
 */
export function AtributosEditor({
  linhaId,
  embedded = false,
}: {
  linhaId: string;
  embedded?: boolean;
}) {
  const atributos = useLinhaAtributos(linhaId);
  const createAtributo = useCreateLinhaAtributo();
  const deleteAtributo = useDeleteLinhaAtributo();

  const [chave, setChave] = useState("");
  const [tipo, setTipo] = useState<AtributoTipo>("texto");
  const [obrigatorio, setObrigatorio] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const items = atributos.data?.items ?? [];

  async function onAdd() {
    const chaveTrim = chave.trim();
    if (!chaveTrim) {
      setErro("Informe a chave do atributo.");
      return;
    }
    setErro(null);
    try {
      await createAtributo.mutateAsync({
        linhaId,
        input: { chave: chaveTrim, tipo, obrigatorio },
      });
      setChave("");
      setTipo("texto");
      setObrigatorio(false);
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 409
          ? `Já existe um atributo "${chaveTrim}" nesta linha.`
          : "Não foi possível adicionar o atributo. Tente novamente.",
      );
    }
  }

  async function onRemove(atributo: LinhaAtributo) {
    setRemovingId(atributo.id);
    setErro(null);
    try {
      await deleteAtributo.mutateAsync({ linhaId, atributoId: atributo.id });
    } catch {
      setErro("Não foi possível remover o atributo. Tente novamente.");
    } finally {
      setRemovingId(null);
    }
  }

  const body = (
    <>
      <div
        className="section-title"
        style={{
          margin: "0 0 14px",
          ...(embedded
            ? { paddingTop: 18, borderTop: "1px solid var(--border)" }
            : null),
        }}
      >
        <h3>Atributos da linha</h3>
        <span className="count">{items.length} definidos</span>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: "12.5px", color: "var(--muted)" }}>
        Estes pares definem o schema que cada Produto da linha preenche. Marque
        como obrigatório os atributos que todo Produto deve informar.
      </p>

      {atributos.isLoading ? (
        <div className="tbl-wrap">
          <table>
            <tbody>
              {Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}>
                  <td>
                    <span className="skel skel-line" style={{ width: "60%" }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : atributos.isError ? (
        <div className="empty">
          <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
          <h4>Não foi possível carregar os atributos</h4>
          <p>Tente novamente em instantes.</p>
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => atributos.refetch()}
            >
              Tentar novamente
            </button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <Plus aria-hidden="true" />
          <h4>Nenhum atributo definido</h4>
          <p>
            Adicione abaixo as características que os Produtos desta linha terão
            (ex.: cor, voltagem, capacidade).
          </p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Chave</th>
                <th>Tipo</th>
                <th>Obrigatório</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.chave}</td>
                  <td className="sub">{tipoLabel(a.tipo)}</td>
                  <td>{a.obrigatorio ? "Sim" : "Não"}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onRemove(a)}
                      disabled={removingId === a.id}
                      aria-label={`Remover atributo ${a.chave}`}
                    >
                      {removingId === a.id ? (
                        <Loader2 className="spin" aria-hidden="true" />
                      ) : (
                        <Trash2 aria-hidden="true" />
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div
        className="grid-fields"
        style={{
          gridTemplateColumns: "1fr 150px auto auto",
          alignItems: "end",
          marginTop: 16,
          gap: 12,
        }}
      >
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="atributo-chave">Chave</label>
          <input
            id="atributo-chave"
            type="text"
            placeholder="ex.: voltagem"
            value={chave}
            onChange={(e) => {
              setChave(e.target.value);
              setErro(null);
            }}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="atributo-tipo">Tipo</label>
          <select
            id="atributo-tipo"
            value={tipo}
            onChange={(e) => setTipo(e.target.value as AtributoTipo)}
          >
            {TIPOS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <label className={cn("chk", obrigatorio && "on")} style={{ height: 40 }}>
          <input
            type="checkbox"
            checked={obrigatorio}
            onChange={(e) => setObrigatorio(e.target.checked)}
          />
          <div className="t">Obrigatório</div>
        </label>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onAdd}
          disabled={createAtributo.isPending}
        >
          {createAtributo.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Plus aria-hidden="true" />
          )}
          <span>Adicionar</span>
        </button>
      </div>
      {erro && (
        <div className="err-msg" style={{ display: "flex", marginTop: 12 }}>
          <TriangleAlert aria-hidden="true" />
          {erro}
        </div>
      )}
    </>
  );

  return embedded ? body : <div className="card">{body}</div>;
}
