import { apiFetch } from "@/lib/api/client";

// ---------------------------------------------------------------------
// Cliente do Edge drive-oauth (conexao da conta Google do Drive pelo
// cockpit). O STATUS (conta conectada) e hidratado server-side na pagina
// Fontes; aqui fica so a INICIACAO do fluxo, que devolve a URL de
// consentimento do Google para o navegador redirecionar. O callback volta
// direto na Edge (URL estavel), grava o refresh_token no Vault e redireciona
// de volta ao cockpit com ?drive=conectado|erro.
// ---------------------------------------------------------------------

/** POST /drive-oauth { action:'iniciar' } — URL de consentimento do Google. */
export function iniciarConexaoDrive(): Promise<{ url: string }> {
  return apiFetch<{ url: string }>("drive-oauth", {
    method: "POST",
    body: JSON.stringify({ action: "iniciar" }),
  });
}
