// =====================================================================
// Schemas zod client-side da feature "Relacionamentos".
//
// Espelham (nao duplicam) os schemas do backend em
// `supabase/functions/_shared/validation.ts`, expostos para validacao
// de formularios no frontend (react-hook-form + zodResolver). Mensagens
// em PT-BR e a sentinela anti numero_pregao permanecem IDÊNTICAS as do
// backend (a constraint SQL tambem bloqueia, mas a borda zod devolve 422
// explicito em vez de 500).
// =====================================================================

import { z } from "zod";

// ---------------------------------------------------------------------
// Enums e constantes compartilhadas com o backend.
// ---------------------------------------------------------------------

export const RELACIONAMENTOS_TIPOS_NO = [
  "aviso",
  "processo",
  "documento",
  "pessoa",
  "produto",
  "linha",
  "sku",
  "preco",
  "politica",
  "cotacao_diretriz",
] as const;
export type RelacionamentoTipoNoZod = (typeof RELACIONAMENTOS_TIPOS_NO)[number];

export const RELACIONAMENTOS_COMBINACOES = ["simples", "composta"] as const;
export type RelacionamentoCombinacaoZod = (typeof RELACIONAMENTOS_COMBINACOES)[number];

export const RELACIONAMENTOS_VINCULO_ORIGENS = ["lia", "humano"] as const;
export const RELACIONAMENTOS_VINCULO_STATUS = ["proposta", "ativa", "rejeitada"] as const;
export const RELACIONAMENTOS_VINCULO_DECISOES = ["aprovar", "rejeitar", "editar"] as const;

/** Mensagem canonica anti numero_pregao. IDENTICA ao backend e ao trigger SQL. */
export const REL_NUMERO_PREGAO_MSG =
  "Numero do pregao sozinho gera falsos positivos. Use regra composta com UASG.";

// ---------------------------------------------------------------------
// Schemas para o catalogo de regras humanas (catalogo_regras_vinculo).
// ---------------------------------------------------------------------

const relacionamentoTipoNoEnum = z.enum(RELACIONAMENTOS_TIPOS_NO, {
  errorMap: () => ({
    message:
      "tipo invalido (use: aviso, processo, documento, pessoa, produto, linha, sku, preco, politica, cotacao_diretriz)",
  }),
});

const relacionamentoCombinacaoEnum = z.enum(RELACIONAMENTOS_COMBINACOES, {
  errorMap: () => ({ message: "combinacao invalida (use: simples, composta)" }),
});

const sequenciaSchema = z
  .array(
    z
      .string({ invalid_type_error: "sequencia deve conter apenas strings" })
      .trim()
      .min(1, "sequencia nao pode conter strings vazias")
      .max(120, "item de sequencia muito longo"),
    { invalid_type_error: "sequencia deve ser uma lista" },
  )
  .max(20, "sequencia muito longa")
  .optional();

const catalogoRegraBaseSchema = z.object({
  origem_tipo: relacionamentoTipoNoEnum,
  campo_origem: z
    .string({
      required_error: "campo_origem e obrigatorio",
      invalid_type_error: "campo_origem deve ser string",
    })
    .trim()
    .min(1, "campo_origem nao pode ser vazio")
    .max(120, "campo_origem muito longo"),
  destino_tipo: relacionamentoTipoNoEnum,
  campo_destino: z
    .string({
      required_error: "campo_destino e obrigatorio",
      invalid_type_error: "campo_destino deve ser string",
    })
    .trim()
    .min(1, "campo_destino nao pode ser vazio")
    .max(120, "campo_destino muito longo"),
  combinacao: relacionamentoCombinacaoEnum,
  sequencia: sequenciaSchema,
  ativa: z.boolean({ invalid_type_error: "ativa deve ser booleano" }).optional(),
  nome: z
    .string()
    .trim()
    .min(1, "nome nao pode ser vazio")
    .max(200, "nome muito longo")
    .nullable()
    .optional(),
});

/** Schema de criacao de regra humana. Refine anti numero_pregao. */
export const regraCreateSchema = catalogoRegraBaseSchema
  .strict()
  .superRefine((val, ctx) => {
    if (val.combinacao === "simples" && val.campo_destino === "numero_pregao") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["campo_destino"],
        message: REL_NUMERO_PREGAO_MSG,
      });
    }
  });

/** Schema de atualizacao parcial de regra humana. */
export const regraUpdateSchema = catalogoRegraBaseSchema
  .partial()
  .strict()
  .superRefine((val, ctx) => {
    if (
      val.combinacao === "simples" &&
      val.campo_destino !== undefined &&
      val.campo_destino === "numero_pregao"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["campo_destino"],
        message: REL_NUMERO_PREGAO_MSG,
      });
    }
  });

// ---------------------------------------------------------------------
// Schemas para vinculos inferidos pela Lia (vinculos_inferidos_lia).
// ---------------------------------------------------------------------

const vinculoLiaOrigemEnum = z.enum(RELACIONAMENTOS_VINCULO_ORIGENS, {
  errorMap: () => ({ message: "origem invalida (use: lia, humano)" }),
});

const vinculoLiaDecisaoEnum = z.enum(RELACIONAMENTOS_VINCULO_DECISOES, {
  errorMap: () => ({ message: "acao invalida (use: aprovar, rejeitar, editar)" }),
});

/** Schema de POST /relacionamentos-vinculos-lia (criar vinculo). */
export const vinculoLiaCreateSchema = z
  .object({
    descricao: z
      .string({
        required_error: "descricao e obrigatoria",
        invalid_type_error: "descricao deve ser string",
      })
      .trim()
      .min(1, "descricao nao pode ser vazia")
      .max(2000, "descricao muito longa"),
    origem: vinculoLiaOrigemEnum,
    contador_uso: z
      .number({ invalid_type_error: "contador_uso deve ser numero" })
      .int("contador_uso deve ser inteiro")
      .min(0, "contador_uso nao pode ser negativo")
      .optional(),
    contador_2caminhos: z
      .number({ invalid_type_error: "contador_2caminhos deve ser numero" })
      .int("contador_2caminhos deve ser inteiro")
      .min(0, "contador_2caminhos nao pode ser negativo")
      .optional(),
    regra_macro_id: z
      .string()
      .uuid("regra_macro_id invalido")
      .nullable()
      .optional(),
    motivo: z
      .string()
      .trim()
      .min(1, "motivo nao pode ser vazio")
      .max(2000, "motivo muito longo")
      .optional(),
  })
  .strict();

/** Schema de PUT /relacionamentos-vinculos-lia/:id. */
export const vinculoLiaUpdateSchema = z
  .object({
    descricao: z
      .string()
      .trim()
      .min(1, "descricao nao pode ser vazia")
      .max(2000, "descricao muito longa")
      .optional(),
    contador_uso: z
      .number({ invalid_type_error: "contador_uso deve ser numero" })
      .int("contador_uso deve ser inteiro")
      .min(0, "contador_uso nao pode ser negativo")
      .optional(),
    contador_2caminhos: z
      .number({ invalid_type_error: "contador_2caminhos deve ser numero" })
      .int("contador_2caminhos deve ser inteiro")
      .min(0, "contador_2caminhos nao pode ser negativo")
      .optional(),
    motivo: z
      .string()
      .trim()
      .min(1, "motivo nao pode ser vazio")
      .max(2000, "motivo muito longo")
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (Object.keys(val).filter((k) => k !== "motivo").length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["(corpo)"],
        message:
          "informe ao menos um campo editavel (descricao, contador_uso, contador_2caminhos)",
      });
    }
  });

/**
 * Schema de POST /relacionamentos-vinculos-lia/decidir.
 * O refine exige motivo quando acao != 'aprovar' (espelho do backend).
 */
export const vinculoLiaDecidirSchema = z
  .object({
    vinculo_id: z
      .string({
        required_error: "vinculo_id e obrigatorio",
        invalid_type_error: "vinculo_id deve ser string",
      })
      .uuid("vinculo_id invalido"),
    acao: vinculoLiaDecisaoEnum,
    dados: z
      .object({
        origem_tipo: relacionamentoTipoNoEnum,
        destino_tipo: relacionamentoTipoNoEnum,
        combinacao: relacionamentoCombinacaoEnum,
        sequencia: sequenciaSchema,
        nome: z
          .string()
          .trim()
          .min(1, "nome nao pode ser vazio")
          .max(200, "nome muito longo")
          .optional(),
      })
      .strict(),
    motivo: z
      .string()
      .trim()
      .min(1, "motivo nao pode ser vazio")
      .max(2000, "motivo muito longo")
      .optional(),
    descricao: z
      .string()
      .trim()
      .min(1, "descricao nao pode ser vazia")
      .max(2000, "descricao muito longa")
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      val.acao !== "aprovar" &&
      (val.motivo === undefined || val.motivo.trim() === "")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["motivo"],
        message: "motivo e obrigatorio para acoes de rejeicao ou edicao",
      });
    }
  });

// ---------------------------------------------------------------------
// Schemas para config (config_relacionamentos + config_tipos_no).
// ---------------------------------------------------------------------

/** Schema de PUT /relacionamentos-config. */
export const configUpdateSchema = z
  .object({
    uso_minimo_promocao_alternativa: z
      .number({ invalid_type_error: "uso_minimo_promocao_alternativa deve ser numero" })
      .int("uso_minimo_promocao_alternativa deve ser inteiro")
      .min(0, "uso_minimo_promocao_alternativa nao pode ser negativo")
      .optional(),
    dois_caminhos_minimo: z
      .number({ invalid_type_error: "dois_caminhos_minimo deve ser numero" })
      .int("dois_caminhos_minimo deve ser inteiro")
      .min(0, "dois_caminhos_minimo nao pode ser negativo")
      .optional(),
    uso_minimo_promocao: z
      .number({ invalid_type_error: "uso_minimo_promocao deve ser numero" })
      .int("uso_minimo_promocao deve ser inteiro")
      .min(0, "uso_minimo_promocao nao pode ser negativo")
      .optional(),
    cap_panorama: z
      .number({ invalid_type_error: "cap_panorama deve ser numero" })
      .int("cap_panorama deve ser inteiro")
      .min(1, "cap_panorama deve ser >= 1")
      .nullable()
      .optional(),
    cap_vizinhanca: z
      .number({ invalid_type_error: "cap_vizinhanca deve ser numero" })
      .int("cap_vizinhanca deve ser inteiro")
      .min(1, "cap_vizinhanca deve ser >= 1")
      .optional(),
    profundidade_max_lia: z
      .number({ invalid_type_error: "profundidade_max_lia deve ser numero" })
      .int("profundidade_max_lia deve ser inteiro")
      .min(1, "profundidade_max_lia deve ser >= 1")
      .max(5, "profundidade_max_lia deve ser <= 5")
      .optional(),
    profundidade_default_panorama: z
      .number({ invalid_type_error: "profundidade_default_panorama deve ser numero" })
      .int("profundidade_default_panorama deve ser inteiro")
      .min(1, "profundidade_default_panorama deve ser >= 1")
      .max(5, "profundidade_default_panorama deve ser <= 5")
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (Object.keys(val).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["(corpo)"],
        message: "informe ao menos um campo para atualizar",
      });
    }
  });

/** Schema de POST /relacionamentos-config/tipos (criar tipo de no). */
export const configTipoCreateSchema = z
  .object({
    tipo: relacionamentoTipoNoEnum,
    label: z
      .string({
        required_error: "label e obrigatorio",
        invalid_type_error: "label deve ser string",
      })
      .trim()
      .min(1, "label nao pode ser vazio")
      .max(80, "label muito longo"),
    icone: z
      .string({
        required_error: "icone e obrigatorio",
        invalid_type_error: "icone deve ser string",
      })
      .trim()
      .min(1, "icone nao pode ser vazio")
      .max(80, "icone muito longo"),
    cor: z
      .string({ required_error: "cor e obrigatoria", invalid_type_error: "cor deve ser string" })
      .trim()
      .regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "cor deve ser um hex (#RRGGBB ou #RRGGBBAA)"),
    ordem: z
      .number({ invalid_type_error: "ordem deve ser numero" })
      .int("ordem deve ser inteiro")
      .min(0, "ordem nao pode ser negativa")
      .optional(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
  })
  .strict();

/**
 * Schema de PUT /relacionamentos-config/tipos (atualizar tipo de no).
 * Exige `id` OU `tipo` como identificador.
 */
export const configTipoUpdateSchema = z
  .object({
    id: z.string().uuid("id invalido").optional(),
    tipo: relacionamentoTipoNoEnum.optional(),
    label: z
      .string()
      .trim()
      .min(1, "label nao pode ser vazio")
      .max(80, "label muito longo")
      .optional(),
    icone: z
      .string()
      .trim()
      .min(1, "icone nao pode ser vazio")
      .max(80, "icone muito longo")
      .optional(),
    cor: z
      .string()
      .trim()
      .regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "cor deve ser um hex (#RRGGBB ou #RRGGBBAA)")
      .optional(),
    ordem: z
      .number({ invalid_type_error: "ordem deve ser numero" })
      .int("ordem deve ser inteiro")
      .min(0, "ordem nao pode ser negativa")
      .optional(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.id === undefined && val.tipo === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["(corpo)"],
        message: "informe ao menos um identificador (id ou tipo)",
      });
    }
  });

// ---------------------------------------------------------------------
// Schema da travessia (POST /relacionamentos-vizinhanca).
// ---------------------------------------------------------------------

/** Schema do payload de entrada da travessia. */
export const vizinhancaInputSchema = z
  .object({
    tipo: relacionamentoTipoNoEnum,
    id: z
      .string({ required_error: "id e obrigatorio", invalid_type_error: "id deve ser string" })
      .trim()
      .min(1, "id nao pode ser vazio")
      .max(255, "id muito longo"),
    profundidade: z
      .number({ invalid_type_error: "profundidade deve ser numero" })
      .int("profundidade deve ser inteiro")
      .min(0, "profundidade deve ser >= 0")
      .max(5, "profundidade deve ser <= 5")
      .optional(),
  })
  .strict();
