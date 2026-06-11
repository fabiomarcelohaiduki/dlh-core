// =====================================================================
// _shared/github.ts
// Helpers da GitHub REST API compartilhados pelos endpoints de disparo manual
// (nomus/gmail/drive/extracao-disparar). Centraliza o owner/repo (antes
// hardcoded em cada funcao) lendo de env.githubRepo, parametrizavel via
// GITHUB_REPO sem reescrever as funcoes.
// =====================================================================

import { getEnv } from "./env.ts";

/**
 * URL da listagem de runs de um workflow (ex.: "coletar-nomus.yml").
 * Usada pelos guards anti-duplo-disparo para checar runs ainda ativos.
 */
export function workflowRunsUrl(workflow: string, perPage = 10): string {
  return `https://api.github.com/repos/${getEnv().githubRepo}/actions/workflows/${workflow}/runs?per_page=${perPage}`;
}
