# Changelog

Registro de mudanças relevantes do dlh-core. Datas em formato ISO (AAAA-MM-DD).

## [Não lançado]

### C2 — Adoção de `_shared/block-source.ts` em `effecti-pipeline.ts` / `nomus-pipeline.ts`

Branch: `feat/extracao-itens-fidelidade-sprint1`

Eliminação da duplicação literal byte-a-byte de 6 helpers (`envInt`, `formatDuration`,
`janelaMovel`, `loadCounters`, `updateExecucao`, `finalizeConcluida`), que passam a viver
em uma única cópia canônica em `supabase/functions/_shared/block-source.ts`.

#### Changed
- `_shared/block-source.ts`: o tipo do `checkpoint` em `ExecucaoPatch` e no parâmetro de
  `finalizeConcluida` foi alargado de `CheckpointEnvelope<unknown>` para
  `{ [k: string]: unknown }` (decisão D5), tornando o blob opaco ao seam.
- `_shared/effecti-pipeline.ts`: removidas as cópias locais de `envInt`, `loadCounters`,
  `finalizeConcluida`, `updateExecucao` e `formatDuration`; passam a ser importadas do seam
  canônico `./block-source.ts`. Exports públicos (`runEffectiBlock`, `effectiBlocoMaxPaginas`,
  `effectiBlocoMaxMs`, `effectiMaxRetomadas`) inalterados.
- `_shared/nomus-pipeline.ts`: removidas as cópias locais dos 6 helpers (incluindo
  `janelaMovel`); passam a ser importadas de `./block-source.ts`. Adicionado o shim
  `export { janelaMovel } from "./block-source.ts";` (decisão D6) para preservar as bordas
  que consomem `janelaMovel` re-exportado.

#### Nota de drift D4 — migração de filtros de log (observability)

logs de erro de updateExecucao/finalizeConcluida agora carregam o prefixo [block-source];
filtros por [effecti-pipeline]/[nomus-pipeline]/[pipeline] devem migrar para [block-source]
ou para execucaoId.

Em outras palavras: Logs de erro de `updateExecucao`/`finalizeConcluida` em
`_shared/block-source.ts` agora carregam prefixo `[block-source]` (antes, as cópias locais
logavam `[effecti-pipeline]`, `[nomus-pipeline]` ou `[pipeline]`). Dashboards e alertas que
filtravam por `[effecti-pipeline]`/`[nomus-pipeline]`/`[pipeline]` nesses logs de erro devem
migrar para `[block-source]` ou para `execucaoId`. Logs `info` contextuais por fonte não são
afetados; este drift atinge apenas os logs de erro dos 3 helpers compartilhados do `_shared/`.
