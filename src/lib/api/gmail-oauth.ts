import { apiFetch } from "@/lib/api/client";

// ---------------------------------------------------------------------
// Cliente do Edge gmail-oauth (conexao da conta Google do Gmail pelo
// cockpit, INDEPENDENTE do Drive). O STATUS (conta conectada) e hidratado
// server-side na pagina Fontes; aqui fica so a INICIACAO do fluxo, que
// devolve a URL de consentimento do Google para o navegador redirecionar. O
// callback volta direto na Edge (URL estavel), grava o refresh_token no Vault
// e redireciona de volta ao cockpit com ?gmail=conectado|erro.
// ---------------------------------------------------------------------

/** POST /gmail-oauth { action:'iniciar' } — URL de consentimento do Google. */
export function iniciarConexaoGmail(): Promise<{ url: string }> {
  return apiFetch<{ url: string }>("gmail-oauth", {
    method: "POST",
    body: JSON.stringify({ action: "iniciar" }),
  });
}
