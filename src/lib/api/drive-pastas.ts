import { apiFetch } from "@/lib/api/client";

// ---------------------------------------------------------------------
// Cliente do Edge drive-pastas (camada 1, fonte 'drive'). A LISTA e
// hidratada server-side (RLS) na pagina Fontes; aqui ficam so as ESCRITAS
// (salvar/remover), que passam pelo Edge (service_role + audit). O runner
// le as pastas ativas por conta propria (action='ativas', X-Cron-Secret).
// ---------------------------------------------------------------------

export interface SalvarDrivePastaInput {
  /** Id ou link da pasta do Drive. O Edge normaliza URL -> id. */
  folderId: string;
  nome: string;
  ativo: boolean;
}

/** POST /drive-pastas { action:'salvar' } — upsert por folder_id. */
export function salvarDrivePasta(
  input: SalvarDrivePastaInput,
): Promise<{ ok: boolean; folderId: string }> {
  return apiFetch<{ ok: boolean; folderId: string }>("drive-pastas", {
    method: "POST",
    body: JSON.stringify({
      action: "salvar",
      folderId: input.folderId,
      nome: input.nome,
      ativo: input.ativo,
    }),
  });
}

/** POST /drive-pastas { action:'remover' } — apaga a pasta por id. */
export function removerDrivePasta(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("drive-pastas", {
    method: "POST",
    body: JSON.stringify({ action: "remover", id }),
  });
}
