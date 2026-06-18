// =====================================================================
// _shared/triagem-ingestao.ts
// Nucleo DETERMINISTICO da ingestao do veredito (Caminho 2): a confianca
// chega CRUA do Lion e o SERVIDOR aplica as regras duras (E5), os limiares do
// `config_automacao` (fonte unica de verdade) e a invariante "util tem produto"
// (E12), classificando em `lixo` / `duvida` / `util` e produzindo o estado
// vigente a gravar em `avisos`.
//
// Esta camada e PURA e SEM IO (nenhuma chamada a banco/HTTP/relogio externo):
//   - `avaliarRegras(texto, regras)` -> casa termos contra o texto do aviso;
//   - `classificar(confianca, produtoCandidato, regras, config)` -> veredito;
//   - `produzirEstadoVigente(...)` -> patch de colunas vigentes (sem efeitos IO).
//
// Manter a classificacao pura e determinista e requisito de design (E3): a
// re-derivacao em massa da sprint-005 REUSA `classificar` sem efeitos colaterais
// (reclassifica historico aplicando os mesmos limiares/regras). Os EFEITOS
// (favoritar no Effecti, marcar lixeira, auditar) ficam na borda (endpoint),
// nunca aqui.
// =====================================================================

/** Veredito server-side derivado da confianca crua + regras + limiares. */
export type Veredito = "lixo" | "duvida" | "util";

/** Referencia mascarada do produto candidato (apenas id + nome). */
export interface ProdutoCandidatoRef {
  produto_id: string | null;
  nome: string | null;
}

/** Regras duras ativas agrupadas por tipo (termos crus). */
export interface RegrasDuras {
  fora_de_ramo: string[];
  termo_produto: string[];
}

/** Resultado do casamento das regras duras contra o texto do aviso. */
export interface RegrasCasadas {
  fora_de_ramo: boolean;
  termo_produto: boolean;
}

/** Limiares de classificacao (config_automacao - fonte unica de verdade). */
export interface LimiaresConfig {
  limiar_inferior: number;
  limiar_superior: number;
}

/** Resultado da classificacao (veredito final + rastreabilidade das regras). */
export interface ClassificacaoResult {
  veredito: Veredito;
  /** Termo `fora_de_ramo` casou -> forcou `lixo` (override dos limiares, E5). */
  fora_de_ramo_casado: boolean;
  /** Termo `termo_produto` casou -> aplicou o PISO de confianca (E5). */
  termo_produto_casado: boolean;
  /** Classificaria `util` mas sem produto -> rebaixado para `duvida` (E12). */
  rebaixado_por_invariante: boolean;
}

/**
 * Normaliza um texto para casamento robusto de termo: remove acentos
 * (diacriticos) e baixa a caixa. Casamento por substring simples, suficiente
 * para a allowlist editavel de regras duras (operador controla os termos).
 */
function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Casa as regras duras contra o texto do aviso (objeto + verbatim). Termo
 * vazio nunca casa. Retorna apenas os flags por tipo (sem expor qual termo).
 */
export function avaliarRegras(texto: string, regras: RegrasDuras): RegrasCasadas {
  const alvo = normalize(texto ?? "");
  const casa = (termos: string[]): boolean =>
    termos.some((t) => {
      const termo = normalize((t ?? "").trim());
      return termo !== "" && alvo.includes(termo);
    });
  return {
    fora_de_ramo: casa(regras.fora_de_ramo ?? []),
    termo_produto: casa(regras.termo_produto ?? []),
  };
}

/**
 * Classifica a confianca CRUA do Lion no veredito server-side. Determinista e
 * pura (reusavel pela re-derivacao em massa, E3). Ordem (E5 antes dos limiares):
 *
 *   1. `fora_de_ramo` casado -> FORCA `lixo` (override dos limiares).
 *   2. `termo_produto` casado -> aplica PISO de confianca = `limiar_inferior`
 *      (a confianca efetiva nunca cai abaixo do piso; garante no minimo
 *      `duvida`, nunca `lixo`, quando ha termo de produto casado).
 *   3. Limiares (`config_automacao`): efetiva < inferior -> `lixo`;
 *      inferior <= efetiva <= superior -> `duvida`; efetiva > superior -> `util`.
 *   4. Invariante "util tem produto" (E12): classificaria `util` mas
 *      `produto_candidato` nulo -> REBAIXA para `duvida`.
 */
export function classificar(
  confianca: number,
  produtoCandidato: ProdutoCandidatoRef | null,
  regras: RegrasCasadas,
  config: LimiaresConfig,
): ClassificacaoResult {
  const temProduto = Boolean(produtoCandidato && produtoCandidato.produto_id);

  // 1. Regra dura `fora_de_ramo`: override deterministico para `lixo`.
  if (regras.fora_de_ramo) {
    return {
      veredito: "lixo",
      fora_de_ramo_casado: true,
      termo_produto_casado: regras.termo_produto,
      rebaixado_por_invariante: false,
    };
  }

  // 2. PISO por `termo_produto`: eleva a confianca efetiva ao limiar inferior.
  //    O piso = limiar_inferior <= limiar_superior, logo nunca atinge `util`
  //    sozinho (so a confianca crua > superior alcanca `util`).
  const efetiva = regras.termo_produto ? Math.max(confianca, config.limiar_inferior) : confianca;

  // 3. Limiares do config_automacao (fonte unica de verdade).
  let veredito: Veredito;
  if (efetiva < config.limiar_inferior) {
    veredito = "lixo";
  } else if (efetiva <= config.limiar_superior) {
    veredito = "duvida";
  } else {
    veredito = "util";
  }

  // 4. Invariante E12: `util` exige produto candidato; senao rebaixa a `duvida`.
  let rebaixado = false;
  if (veredito === "util" && !temProduto) {
    veredito = "duvida";
    rebaixado = true;
  }

  return {
    veredito,
    fora_de_ramo_casado: false,
    termo_produto_casado: regras.termo_produto,
    rebaixado_por_invariante: rebaixado,
  };
}

/** Parametros para materializar o estado vigente (puro, sem IO). */
export interface EstadoVigenteParams {
  classificacao: ClassificacaoResult;
  /** Confianca CRUA recebida do Lion (gravada como-veio em `avisos`). */
  confiancaCrua: number;
  /** Trava anti-loop (RF-30): aviso reabilitado nao volta para a lixeira. */
  reabilitado: boolean;
  /** Timestamp ISO injetado pela borda (mantem a funcao deterministica). */
  agora: string;
}

/** Estado vigente resultante: patch de `avisos` + flags de efeito. */
export interface EstadoVigente {
  veredito: Veredito;
  /** Patch das colunas vigentes de `avisos` (sem `favorito`/`favorito_propagado`). */
  patch: Record<string, unknown>;
  /** `util` -> a borda deve favoritar no Effecti e marcar favorito. */
  favoritar: boolean;
  /** `lixo` (e nao reabilitado) -> aviso vai para a lixeira soft. */
  naLixeira: boolean;
}

/**
 * Produz o estado vigente a partir da classificacao: monta o patch base
 * (`triagem_veredito`/`triagem_confianca`/`triagem_em`) e adiciona a lixeira
 * soft (`na_lixeira`/`na_lixeira_em`) quando o veredito e `lixo` e o aviso NAO
 * esta reabilitado. As colunas `favorito`/`favorito_propagado` ficam a cargo da
 * borda (dependem do resultado best-effort do favoritar no Effecti).
 */
export function produzirEstadoVigente(params: EstadoVigenteParams): EstadoVigente {
  const { classificacao, confiancaCrua, reabilitado, agora } = params;

  const patch: Record<string, unknown> = {
    triagem_veredito: classificacao.veredito,
    triagem_confianca: confiancaCrua,
    triagem_em: agora,
  };

  const naLixeira = classificacao.veredito === "lixo" && !reabilitado;
  if (naLixeira) {
    patch.na_lixeira = true;
    patch.na_lixeira_em = agora;
  }

  const favoritar = classificacao.veredito === "util";

  return { veredito: classificacao.veredito, patch, favoritar, naLixeira };
}
