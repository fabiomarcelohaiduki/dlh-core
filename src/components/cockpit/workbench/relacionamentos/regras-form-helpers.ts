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
//     (toRegraCreateInput / toRegraUpdateInput), mantendo snake_case.
//
// Os campos disponiveis por tipo de no NAO moram mais aqui: vem do
// servidor (Edge relacionamentos-tipos-no, que le a tabela_fonte de cada
// tipo em config_tipos_no via information_schema).
//
// Esses helpers sao separados do componente para preservar o corpo do
// form limpo e permitir testes unitarios futuros sem renderizar React.
// =====================================================================

import type {
  Regra,
  RegraCreateInput,
  RegraUpdateInput,
  RelacionamentoCombinacao,
  RelacionamentoModoDisparo,
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
  modo_disparo: RelacionamentoModoDisparo;
  ativa: boolean;
}

/**
 * Defaults limpos para o modo criacao. Os campos comecam vazios: o form
 * preenche com a 1a coluna real do tipo assim que os tipos carregam do
 * servidor (nada de nome de campo chutado aqui).
 */
export function regraCreateDefaults(): RegraFormValues {
  return {
    nome: "",
    origem_tipo: "aviso",
    campo_origem: "",
    destino_tipo: "produto",
    campo_destino: "",
    combinacao: "simples",
    sequencia: [],
    modo_disparo: "agendado",
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
    modo_disparo: regra.modo_disparo ?? "agendado",
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
    modo_disparo: values.modo_disparo,
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
    modo_disparo: values.modo_disparo,
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
