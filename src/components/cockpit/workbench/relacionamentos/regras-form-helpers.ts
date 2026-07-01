"use client";

// =====================================================================
// Helpers do formulario de regras humanas.
//
// Reune:
//   - Tipos de valores do form (estende RegraCreateInput e RegraUpdateInput
//     para acomodar `ativa` como boolean obrigatorio, sequencia como array
//     de string|null, e combinacao como enum);
//   - Defaults para criacao e para edicao (hidratacao a partir de Regra);
//   - Conversao dos valores tipados para o payload do backend
//     (toRegraCreateInput / toRegraUpdateInput), mantendo snake_case;
//   - Tabela de campos permitidos por tipo de no (allowlist de origem/destino).
//
// Esses helpers sao separados do componente para preservar o corpo do
// form limpo e permitir testes unitarios futuros sem renderizar React.
// =====================================================================

import type {
  Regra,
  RegraCreateInput,
  RegraUpdateInput,
  RelacionamentoCombinacao,
  RelacionamentoTipoNo,
} from "@/lib/api/relacionamentos-types";

export interface RegraFormValues {
  nome: string;
  origem_tipo: RelacionamentoTipoNo;
  campo_origem: string;
  destino_tipo: RelacionamentoTipoNo;
  campo_destino: string;
  combinacao: RelacionamentoCombinacao;
  /** Lista de campos para regras compostas; array vazio para regras simples. */
  sequencia: string[];
  ativa: boolean;
}

/** Item da tabela de campos permitidos por tipo de no. */
export interface RelacaoTipoNoCampo {
  tipo: RelacionamentoTipoNo;
  campos: ReadonlyArray<{ value: string; label: string }>;
}

/** Defaults limpos para o modo criacao. */
export function regraCreateDefaults(): RegraFormValues {
  return {
    nome: "",
    origem_tipo: "aviso",
    campo_origem: "numero_pregao",
    destino_tipo: "produto",
    campo_destino: "sku",
    combinacao: "composta",
    sequencia: [],
    ativa: true,
  };
}

/** Defaults para o modo edicao (hidrata a partir de uma Regra ja persistida). */
export function regraUpdateDefaults(regra: Regra): RegraFormValues {
  return {
    nome: regra.nome ?? "",
    origem_tipo: regra.origem_tipo,
    campo_origem: regra.campo_origem,
    destino_tipo: regra.destino_tipo,
    campo_destino: regra.campo_destino,
    combinacao: regra.combinacao,
    sequencia: Array.isArray(regra.sequencia) ? regra.sequencia : [],
    ativa: Boolean(regra.ativa),
  };
}

/** Converte os valores do form para o input de POST. Omite campos vazios. */
export function toRegraCreateInput(values: RegraFormValues): RegraCreateInput {
  const input: RegraCreateInput = {
    origem_tipo: values.origem_tipo,
    campo_origem: values.campo_origem.trim(),
    destino_tipo: values.destino_tipo,
    campo_destino: values.campo_destino.trim(),
    combinacao: values.combinacao,
    ativa: values.ativa,
  };
  if (values.combinacao === "composta" && values.sequencia.length > 0) {
    input.sequencia = values.sequencia.map((s) => s.trim()).filter(Boolean);
  }
  const nome = values.nome.trim();
  if (nome) input.nome = nome;
  return input;
}

/** Converte os valores do form para o input de PUT (parcial). */
export function toRegraUpdateInput(values: RegraFormValues): RegraUpdateInput {
  const input: RegraUpdateInput = {
    origem_tipo: values.origem_tipo,
    campo_origem: values.campo_origem.trim(),
    destino_tipo: values.destino_tipo,
    campo_destino: values.campo_destino.trim(),
    combinacao: values.combinacao,
    ativa: values.ativa,
  };
  if (values.combinacao === "composta") {
    input.sequencia = values.sequencia.map((s) => s.trim()).filter(Boolean);
  } else {
    input.sequencia = null;
  }
  const nome = values.nome.trim();
  input.nome = nome ? nome : null;
  return input;
}

// ---------------------------------------------------------------------
// Tabela dominio: tipo de no -> campos permitidos (allowlist).
// Hardcoded intencionalmente: precisa ser estavel para que o match no
// backfill seja deterministico.
// ---------------------------------------------------------------------

type CamposPorTipo = Record<
  RelacionamentoTipoNo,
  ReadonlyArray<{ value: string; label: string }>
>;

export const CAMPOS_POR_TIPO: CamposPorTipo = {
  aviso: [
    { value: "numero_pregao", label: "Número do pregão" },
    { value: "uasg", label: "UASG" },
    { value: "orgao_codigo", label: "Órgão (código)" },
    { value: "orgao_nome", label: "Órgão (nome)" },
    { value: "modalidade", label: "Modalidade" },
    { value: "data_abertura", label: "Data de abertura" },
    { value: "objeto_resumido", label: "Objeto (resumido)" },
  ],
  processo: [
    { value: "numero_processo", label: "Número do processo" },
    { value: "data_inicio", label: "Data de início" },
    { value: "status", label: "Status" },
    { value: "descricao", label: "Descrição" },
  ],
  documento: [
    { value: "nome_anexo", label: "Nome do anexo" },
    { value: "extensao", label: "Extensão" },
    { value: "hash_documento", label: "Hash" },
    { value: "tipo_documento", label: "Tipo do documento" },
  ],
  pessoa: [
    { value: "cpf_cnpj", label: "CPF/CNPJ" },
    { value: "nome", label: "Nome" },
    { value: "email", label: "E-mail" },
    { value: "telefone", label: "Telefone" },
    { value: "tipo_pessoa", label: "Tipo de pessoa" },
  ],
  produto: [
    { value: "sku", label: "SKU" },
    { value: "nome_produto", label: "Nome do produto" },
    { value: "codigo_interno", label: "Código interno" },
    { value: "categoria", label: "Categoria" },
  ],
  linha: [
    { value: "codigo_linha", label: "Código da linha" },
    { value: "nome_linha", label: "Nome da linha" },
  ],
  sku: [
    { value: "codigo_sku", label: "Código do SKU" },
    { value: "nome_sku", label: "Nome do SKU" },
    { value: "tipo_sku", label: "Tipo do SKU" },
  ],
  preco: [
    { value: "sku_id", label: "SKU" },
    { value: "regiao", label: "Região" },
    { value: "patamar", label: "Patamar" },
    { value: "estado", label: "Estado" },
  ],
  politica: [
    { value: "nivel", label: "Nível" },
    { value: "escopo_id", label: "Escopo" },
    { value: "participa", label: "Participa" },
  ],
  cotacao_diretriz: [
    { value: "nivel", label: "Nível" },
    { value: "escopo_id", label: "Escopo" },
    { value: "texto", label: "Texto" },
  ],
};

/** Lista derivada para componentes que precisam enumerar todos os tipos. */
export const CAMPOS_POR_TIPO_LISTA: ReadonlyArray<RelacaoTipoNoCampo> = (
  Object.keys(CAMPOS_POR_TIPO) as RelacionamentoTipoNo[]
).map((tipo) => ({ tipo, campos: CAMPOS_POR_TIPO[tipo] }));
