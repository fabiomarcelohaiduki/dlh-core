// =====================================================================
// _shared/block-adapters/effecti-block-adapter.ts
// Adapter de ciclo de vida da fonte Effecti sobre o seam block-source (D1).
//
// COMPOE o EffectiConnector por dentro (new EffectiConnector({endpointBase,
// token})) e delega a maquina de bloco ao runEffectiBlock existente — NAO
// altera effecti-connector.ts (apenas o consome). O cursor especifico
// (EffectiCursor: bloco_inicio + pagina_atual, DOIS NIVEIS) fica aninhado no
// CheckpointEnvelope generico; os campos de ciclo (janela_*, fase, modo,
// tentativas_retomada) vem do envelope comum de block-source.ts.
//
// modo FIXO 'incremental' (nenhum consumidor le `modo` do Effecti). bloco_inicio
// e o DISCRIMINADOR que faz parseCheckpoint rejeitar checkpoints Nomus/legado.
//
// Hook pos-bloco onBlockComplete: enfileira os vinculos pendentes dos avisos
// recem-persistidos (descobrir_vinculos_effecti, SQL puro + idempotente),
// portado de ingestao-orquestrar/index.ts. BEST-EFFORT: a falha aqui nunca
// propaga nem derruba a coleta.
//
// O caminho Effecti LEGADO (background via waitUntil) NAO entra no seam (D4-X)
// e nao e tocado aqui.
// =====================================================================

import {
  type BlockRunDeps,
  type BlockRunOutcome,
  type BlockRunParams,
  type BlockSourceAdapter,
  type CheckpointEnvelope,
  type InitialCheckpointArgs,
} from "../block-source.ts";
import { EffectiConnector } from "../effecti-connector.ts";
import {
  buildInitialEffectiCheckpoint,
  type EffectiCursor,
  effectiMaxRetomadas,
  parseEffectiCheckpoint,
  runEffectiBlock,
} from "../effecti-pipeline.ts";

// Re-export do cursor para que os testes/consumidores do adapter o importem
// daqui (paridade com o nomus-block-adapter, que reusa NomusCursor do pipeline).
export type { EffectiCursor };

// ---------------------------------------------------------------------
// Adapter Effecti (BlockSourceAdapter<EffectiCursor>)
// ---------------------------------------------------------------------

export const effectiBlockAdapter: BlockSourceAdapter<EffectiCursor> = {
  tipo: "effecti",

  /**
   * Envelope inicial + cursor (bloco = since, pagina 0). modo FIXO 'incremental'
   * (ignora args.modo: nenhum consumidor le `modo` do Effecti).
   */
  buildInitialCheckpoint(args: InitialCheckpointArgs): CheckpointEnvelope<EffectiCursor> {
    return buildInitialEffectiCheckpoint(args.since, args.until);
  },

  /**
   * Valida o checkpoint via o envelope generico + cursor Effecti. Retorna null
   * quando o envelope e invalido (sem janela_inicio) OU o cursor nao tem
   * `bloco_inicio` (ex.: checkpoint Nomus/legado). Tolerante ao formato legado
   * plano (campos de cursor/ciclo no topo).
   */
  parseCheckpoint(raw: unknown): CheckpointEnvelope<EffectiCursor> | null {
    return parseEffectiCheckpoint(raw);
  },

  /** Teto de retomadas apos erro (env EFFECTI_MAX_RETOMADAS, default 3). */
  maxRetomadas(): number {
    return effectiMaxRetomadas();
  },

  /**
   * Roda UM bloco: instancia o EffectiConnector por composicao e delega a
   * maquina de bloco existente (runEffectiBlock), que ja preserva isolamento
   * por item, ordem de persistencia por pagina e erro de infra com checkpoint
   * preservado. Os filtros (modalidades/portais) vem da config da fonte.
   */
  async runBlock(
    deps: BlockRunDeps,
    params: BlockRunParams<EffectiCursor>,
  ): Promise<BlockRunOutcome<EffectiCursor>> {
    const connector = new EffectiConnector({
      endpointBase: deps.fonte.endpoint_base,
      token: deps.token,
    });
    return await runEffectiBlock(
      {
        db: deps.db,
        connector,
        embeddingProvider: deps.embeddingProvider,
        fonteId: deps.fonte.id,
      },
      {
        execucaoId: params.execucaoId,
        checkpoint: params.checkpoint,
        modalidades: deps.config?.modalidades ?? undefined,
        portais: deps.config?.portais ?? undefined,
        signal: params.signal,
      },
    );
  },

  /**
   * Hook pos-bloco: enfileira os anexos dos avisos recem-coletados para extracao
   * (descobrir_vinculos_effecti, idempotente). Sem isso, a coleta AGENDADA traz
   * avisos novos mas nao gera os "arquivos para extracao". BEST-EFFORT: loga e
   * NUNCA lanca (a descoberta manual segue no painel de Extracao).
   */
  async onBlockComplete(deps: BlockRunDeps, execucaoId: string): Promise<void> {
    try {
      const { error } = await deps.db.rpc("descobrir_vinculos_effecti", {
        p_extensoes: null,
        p_limite_avisos: null,
      });
      if (error) {
        console.error("[effecti-block-adapter] descoberta effecti pos-bloco falhou", {
          execucaoId,
          err: error.message,
        });
      }
    } catch (err) {
      // Best-effort: qualquer falha (rede/rpc que lanca) e logada, nunca propaga.
      console.error("[effecti-block-adapter] descoberta effecti pos-bloco lancou", {
        execucaoId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
