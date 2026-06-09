import { apiFetch } from "@/lib/api/client";

// ---------------------------------------------------------------------
// Cliente do Edge gmail-config (camada 1, fonte 'gmail'). A data inicial e as
// labels da BLACKLIST sao hidratadas server-side (RLS) na pagina Fontes; aqui
// ficam so as ESCRITAS (salvar config / upsert label / remover label), que
// passam pelo Edge (service_role + audit). O runner monta a query por conta
// propria (action='montar-query', X-Cron-Secret).
// ---------------------------------------------------------------------

/** POST /gmail-config { action:'salvar-config' } — atualiza a data inicial. */
export function salvarGmailConfig(dataInicial: string): Promise<{ ok: boolean; dataInicial: string }> {
  return apiFetch<{ ok: boolean; dataInicial: string }>("gmail-config", {
    method: "POST",
    body: JSON.stringify({ action: "salvar-config", dataInicial }),
  });
}

/** POST /gmail-config { action:'salvar-categorias' } — substitui a selecao de categorias a excluir. */
export function salvarGmailCategorias(
  categorias: string[],
): Promise<{ ok: boolean; categorias: string[] }> {
  return apiFetch<{ ok: boolean; categorias: string[] }>("gmail-config", {
    method: "POST",
    body: JSON.stringify({ action: "salvar-categorias", categorias }),
  });
}

export interface SalvarGmailLabelInput {
  /** Nome da label do Gmail a EXCLUIR (vira -label:"label" na query). */
  label: string;
  ativo: boolean;
}

/** POST /gmail-config { action:'salvar-label' } — upsert de uma label da blacklist. */
export function salvarGmailLabel(
  input: SalvarGmailLabelInput,
): Promise<{ ok: boolean; label: string }> {
  return apiFetch<{ ok: boolean; label: string }>("gmail-config", {
    method: "POST",
    body: JSON.stringify({ action: "salvar-label", label: input.label, ativo: input.ativo }),
  });
}

/** POST /gmail-config { action:'remover-label' } — apaga a label por id. */
export function removerGmailLabel(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("gmail-config", {
    method: "POST",
    body: JSON.stringify({ action: "remover-label", id }),
  });
}
