"use client";

import { useState } from "react";
import { Loader2, Plus, TriangleAlert, Trash2 } from "lucide-react";
import {
  useCreateLinhaAtributo,
  useDeleteLinhaAtributo,
  useLinhaAtributos,
} from "@/hooks/use-linha-atributos";
import {
  useCreateProdutoAtributo,
  useDeleteProdutoAtributo,
  useProdutoAtributos,
} from "@/hooks/use-produto-atributos";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { AtributoTipo } from "@/lib/api/types";

const TIPOS: { value: AtributoTipo; label: string }[] = [
  { value: "texto", label: "Texto" },
  { value: "numero", label: "Número" },
  { value: "booleano", label: "Booleano" },
];

function tipoLabel(tipo: AtributoTipo): string {
  return TIPOS.find((t) => t.value === tipo)?.label ?? tipo;
}

/** Atributo exibido na tabela (campos comuns a Linha e Produto). */
interface AtributoRow {
  id: string;
  chave: string;
  tipo: AtributoTipo;
  obrigatorio: boolean;
}

type AtributosEditorProps =
  | { scope?: "linha"; linhaId: string; produtoId?: undefined; embedded?: boolean }
  | { scope: "produto"; produtoId: string; linhaId: string; embedded?: boolean };

/**
 * cmp-atributos-editor — define um conjunto de atributos como pares
 * chave/tipo/obrigatorio. Dois escopos:
 *   - 'linha' (produto_linha_atributos): schema que TODO Produto da Linha
 *     preenche; criar/remover aqui muda os campos de todos os Produtos.
 *   - 'produto' (produto_atributos): atributos PROPRIOS de um Produto, somados
 *     aos herdados da Linha. Colisao de chave com a Linha e barrada (409).
 * A chave e unica por escopo (o backend rejeita duplicata com 409, inline).
 *
 * `embedded`: renderiza como SECAO (sem o card proprio), para ficar DENTRO do
 * cadastro/detalhe em vez de um card irmao solto.
 */
export function AtributosEditor(props: AtributosEditorProps) {
  const isProduto = props.scope === "produto";
  const linhaId = props.linhaId;
  const produtoId = isProduto ? props.produtoId : undefined;

  // Hooks chamados incondicionalmente.
  //   - scope 'linha': linhaList e a lista EDITAVEL.
  //   - scope 'produto': produtoList e a EDITAVEL; linhaList vira os HERDADOS
  //     (read-only, exibidos so para contexto).
  const linhaList = useLinhaAtributos(linhaId, { enabled: linhaId != null });
  const produtoList = useProdutoAtributos(produtoId, { enabled: isProduto });
  const list = isProduto ? produtoList : linhaList;

  const createLinha = useCreateLinhaAtributo();
  const createProduto = useCreateProdutoAtributo();
  const deleteLinha = useDeleteLinhaAtributo();
  const deleteProduto = useDeleteProdutoAtributo();
  const createPending = isProduto ? createProduto.isPending : createLinha.isPending;

  const [chave, setChave] = useState("");
  const [tipo, setTipo] = useState<AtributoTipo>("texto");
  const [obrigatorio, setObrigatorio] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const items = (list.data?.items ?? []) as AtributoRow[];
  // No scope 'produto', os atributos da Linha sao exibidos como HERDADOS
  // (read-only). No scope 'linha' nao ha herdados.
  const herdados = isProduto ? ((linhaList.data?.items ?? []) as AtributoRow[]) : [];
  const herdadosLoading = isProduto && linhaList.isLoading;
  const hasNada = items.length === 0 && herdados.length === 0;

  const copy = isProduto
    ? {
        titulo: "Atributos do produto",
        helper: "",
        emptyHelp:
          "Adicione abaixo características específicas deste Produto (que não valem para a linha inteira).",
        placeholder: "ex.: acabamento",
      }
    : {
        titulo: "Atributos da linha",
        helper:
          "Estes pares definem o schema que cada Produto da linha preenche. Marque como obrigatório os atributos que todo Produto deve informar.",
        emptyHelp:
          "Adicione abaixo as características que os Produtos desta linha terão (ex.: cor, voltagem, capacidade).",
        placeholder: "ex.: voltagem",
      };

  async function onAdd() {
    const chaveTrim = chave.trim();
    if (!chaveTrim) {
      setErro("Informe a chave do atributo.");
      return;
    }
    setErro(null);
    const input = { chave: chaveTrim, tipo, obrigatorio };
    try {
      if (isProduto) {
        await createProduto.mutateAsync({ produtoId: produtoId as string, input });
      } else {
        await createLinha.mutateAsync({ linhaId: linhaId as string, input });
      }
      setChave("");
      setTipo("texto");
      setObrigatorio(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "atributo_colide_linha") {
        setErro(`A chave "${chaveTrim}" já é um atributo herdado da Linha.`);
      } else if (err instanceof ApiError && err.status === 409) {
        setErro(
          isProduto
            ? `Já existe um atributo "${chaveTrim}" neste produto.`
            : `Já existe um atributo "${chaveTrim}" nesta linha.`,
        );
      } else {
        setErro("Não foi possível adicionar o atributo. Tente novamente.");
      }
    }
  }

  async function onRemove(atributo: AtributoRow) {
    setRemovingId(atributo.id);
    setErro(null);
    try {
      if (isProduto) {
        await deleteProduto.mutateAsync({
          produtoId: produtoId as string,
          atributoId: atributo.id,
        });
      } else {
        await deleteLinha.mutateAsync({
          linhaId: linhaId as string,
          atributoId: atributo.id,
        });
      }
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
          ...(props.embedded
            ? { paddingTop: 18, borderTop: "1px solid var(--border)" }
            : null),
        }}
      >
        <h3>{copy.titulo}</h3>
        <span className="count">
          {isProduto
            ? `${items.length} próprios · ${herdados.length} herdados`
            : `${items.length} definidos`}
        </span>
      </div>
      {copy.helper && (
        <p style={{ margin: "0 0 14px", fontSize: "12.5px", color: "var(--muted)" }}>
          {copy.helper}
        </p>
      )}

      {list.isLoading || herdadosLoading ? (
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
      ) : list.isError ? (
        <div className="empty">
          <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
          <h4>Não foi possível carregar os atributos</h4>
          <p>Tente novamente em instantes.</p>
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => list.refetch()}
            >
              Tentar novamente
            </button>
          </div>
        </div>
      ) : hasNada ? (
        <div className="empty">
          <Plus aria-hidden="true" />
          <h4>Nenhum atributo definido</h4>
          <p>{copy.emptyHelp}</p>
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
              {herdados.map((a) => (
                <tr key={`herdado-${a.id}`}>
                  <td className="mono">
                    {a.chave}{" "}
                    <span className="tag" style={{ marginLeft: 6 }}>
                      Herdado
                    </span>
                  </td>
                  <td className="sub">{tipoLabel(a.tipo)}</td>
                  <td>{a.obrigatorio ? "Sim" : "Não"}</td>
                  <td />
                </tr>
              ))}
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
            placeholder={copy.placeholder}
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
          disabled={createPending}
        >
          {createPending ? (
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

  return props.embedded ? body : <div className="card">{body}</div>;
}
