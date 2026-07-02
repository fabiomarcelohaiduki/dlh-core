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

export const RELACIONAMENTOS_COMBINACOES = ["simples", "composta"] as const;
export type RelacionamentoCombinacaoZod = (typeof RELACIONAMENTOS_COMBINACOES)[number];

export const RELACIONAMENTOS_MODOS_DISPARO = ["imediato", "agendado", "on-demand"] as const;
export type RelacionamentoModoDisparoZod = (typeof RELACIONAMENTOS_MODOS_DISPARO)[number];

export const RELACIONAMENTOS_VINCULO_ORIGENS = ["lia", "humano"] as const;
export const RELACIONAMENTOS_VINCULO_STATUS = ["rascunho", "ativo", "descartado"] as const;
export const RELACIONAMENTOS_VINCULO_DECISOES = ["aprovar", "rejeitar", "editar"] as const;
export const RELACIONAMENTOS_FEEDBACK_ACOES = ["visto", "incorreta"] as const;

/** Mensagem canonica anti numero_pregao. IDENTICA ao backend e ao trigger SQL. */
export const REL_NUMERO_PREGAO_MSG =
  "Numero do pregao sozinho gera falsos positivos. Use regra composta com UASG.";

/**
 * Campos que representam o numero do pregao sozinho (falso-positivo em regra
 * simples). O numero do pregao real vive na chave jsonb `payload_bruto.processo`;
 * `numero_pregao` e o nome legado. Bloquear os dois cobre dado antigo e novo.
 * IDENTICO ao backend (validation.ts) e ao trigger SQL.
 */
export const REL_CAMPOS_NUMERO_PREGAO = ["numero_pregao", "payload_bruto.processo"] as const;

// ---------------------------------------------------------------------
// Schemas para o catalogo de regras humanas (catalogo_regras_vinculo).
// ---------------------------------------------------------------------

// Tipos de no deixaram de ser enum fechado: agora sao DADOS por org em
// config_tipos_no (administraveis pelo cockpit). O schema valida apenas o
// FORMATO do identificador (espelha o backend + CHECK da tabela).
const relacionamentoTipoNoEnum = z
  .string({ required_error: "tipo e obrigatorio", invalid_type_error: "tipo deve ser string" })
  .trim()
  .min(1, "tipo nao pode ser vazio")
  .max(60, "tipo muito longo")
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "tipo invalido (use minusculas, digitos e underscore, comecando por letra)",
  );

const relacionamentoCombinacaoEnum = z.enum(RELACIONAMENTOS_COMBINACOES, {
  errorMap: () => ({ message: "combinacao invalida (use: simples, composta)" }),
});

const relacionamentoModoDisparoEnum = z.enum(RELACIONAMENTOS_MODOS_DISPARO, {
  errorMap: () => ({ message: "modo_disparo invalido (use: imediato, agendado, on-demand)" }),
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
  modo_disparo: relacionamentoModoDisparoEnum.optional(),
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
    if (
      val.combinacao === "simples" &&
      (REL_CAMPOS_NUMERO_PREGAO as readonly string[]).includes(val.campo_destino)
    ) {
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
      (REL_CAMPOS_NUMERO_PREGAO as readonly string[]).includes(val.campo_destino)
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
// Schema de feedback inline da aresta (POST /relacionamentos-feedback).
// ---------------------------------------------------------------------

const feedbackAcaoEnum = z.enum(RELACIONAMENTOS_FEEDBACK_ACOES, {
  errorMap: () => ({ message: "acao invalida (use: visto, incorreta)" }),
});

/**
 * Schema de POST /relacionamentos-feedback.
 * `motivo` e opcional no geral, mas obrigatorio na MARCACAO de incorreta
 * (a desmarcacao dispensa motivo — o backend faz o toggle reversivel).
 */
export const arestaFeedbackSchema = z
  .object({
    aresta_id: z
      .string({
        required_error: "aresta_id e obrigatorio",
        invalid_type_error: "aresta_id deve ser string",
      })
      .trim()
      .min(1, "aresta_id nao pode ser vazio"),
    acao: feedbackAcaoEnum,
    motivo: z
      .string()
      .trim()
      .min(1, "motivo nao pode ser vazio")
      .max(2000, "motivo muito longo")
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      val.acao === "incorreta" &&
      (val.motivo === undefined || val.motivo.trim() === "")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["motivo"],
        message: "motivo e obrigatorio ao sinalizar a aresta como incorreta",
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

// ---------------------------------------------------------------------
// Schemas do dry-run de regra (POST /relacionamentos-dry-run) e da
// guarda de ativacao (POST /relacionamentos-ativar). Espelham o
// backend em supabase/functions/_shared/validation.ts.
// ---------------------------------------------------------------------

/**
 * Request do dry-run. A Edge e `strict` a `regra_id`; `amostra_max` fica
 * reservado para evolucao do contrato e NAO e enviado enquanto a borda
 * permanecer estrita (evita 400 por chave extra).
 */
export const dryRunRequestSchema = z
  .object({
    regra_id: z
      .string({
        required_error: "regra_id e obrigatorio",
        invalid_type_error: "regra_id deve ser string",
      })
      .uuid("regra_id invalido"),
    amostra_max: z
      .number({ invalid_type_error: "amostra_max deve ser numero" })
      .int("amostra_max deve ser inteiro")
      .min(1, "amostra_max deve ser >= 1")
      .max(100, "amostra_max deve ser <= 100")
      .optional(),
  })
  .strict();

const dryRunNivelEnum = z.enum(["ok", "aviso", "bloqueio"], {
  errorMap: () => ({ message: "nivel invalido (use: ok, aviso, bloqueio)" }),
});

const dryRunAlertaSchema = z.object({
  codigo: z.string(),
  mensagem: z.string(),
});

const dryRunArestaSchema = z.object({
  origem_tipo: z.string(),
  origem_id: z.string(),
  destino_tipo: z.string(),
  destino_id: z.string(),
  relacao: z.string(),
  metodo: z.string(),
  confianca: z.number(),
});

/** Response do dry-run (validacao defensiva do payload da Edge). */
export const dryRunResponseSchema = z.object({
  contagem_total: z.number().int().min(0),
  amostra: z.array(dryRunArestaSchema),
  distribuicao_por_tipo: z.record(z.string(), z.number()),
  score_risco: z.object({
    nivel: dryRunNivelEnum,
    alertas: z.array(dryRunAlertaSchema),
    limite_tecnico_atingido: z.boolean().optional(),
    limite_tecnico_msg: z.string().optional(),
  }),
  regra_hash: z.string().min(1),
  regra_testada: z.object({
    id: z.string(),
    nome: z.string().nullable(),
    origem_tipo: z.string(),
    campo_origem: z.string(),
    destino_tipo: z.string(),
    campo_destino: z.string(),
    combinacao: relacionamentoCombinacaoEnum,
    sequencia: z.array(z.string()).nullable(),
  }),
  config_aplicada: z.object({
    confianca_baixa: z.number(),
    cardinalidade_alta: z.number(),
    duplicidade_pct: z.number(),
    amostra_insuficiente: z.number(),
  }),
});

/**
 * Request da guarda de ativacao (gate S7). Exige `regra_hash` do dry-run
 * fresco e a confirmacao DUPLA. `motivo` e opcional (auditado).
 */
export const ativarRegraRequestSchema = z
  .object({
    regra_id: z
      .string({
        required_error: "regra_id e obrigatorio",
        invalid_type_error: "regra_id deve ser string",
      })
      .uuid("regra_id invalido"),
    regra_hash: z
      .string({
        required_error: "regra_hash e obrigatorio",
        invalid_type_error: "regra_hash deve ser string",
      })
      .trim()
      .min(1, "regra_hash nao pode ser vazio")
      .max(128, "regra_hash muito longo"),
    confirmar: z.boolean({ invalid_type_error: "confirmar deve ser booleano" }),
    confirmar_efeito_permanente: z.boolean({
      invalid_type_error: "confirmar_efeito_permanente deve ser booleano",
    }),
    motivo: z
      .string()
      .trim()
      .min(1, "motivo nao pode ser vazio")
      .max(2000, "motivo muito longo")
      .optional(),
  })
  .strict();

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
