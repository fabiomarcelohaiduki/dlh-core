import type { Metadata } from "next";
import { ContaGoogleView } from "@/components/cockpit/conta-google-view";

export const metadata: Metadata = { title: "Conta Google" };

/**
 * View conta-google (/conta-google).
 *
 * Painel da conta autenticada com pill de sessão (#accountSessionPill) e
 * encerramento manual. O conteúdo é client-side (identidade da sessão + tempo
 * de expiração); esta página é apenas a casca server + metadata.
 */
export default function ContaGooglePage() {
  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Conta</h2>
          <p>Sessão autenticada com Google pelo Supabase Auth.</p>
        </div>
      </div>

      <ContaGoogleView />
    </section>
  );
}
