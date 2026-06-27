import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CockpitShell } from "@/components/cockpit/cockpit-shell";
import { CockpitView } from "@/components/cockpit/cockpit-view";
import { SessionProvider } from "@/components/auth/session-provider";
import { loadConexoesFontes } from "@/lib/conexoes-fontes";

/**
 * Rota / — view default do cockpit (SPEC 4.3.3 / 4.6).
 *
 * Renderiza a view cockpit (cards de modulo + paineis fixos em empty-state
 * honesto) dentro do shell persistente. Por viver na raiz (fora do route
 * group `(cockpit)`), monta o proprio CockpitShell — reusando o mesmo loader
 * de conexoes do layout do grupo. O middleware ja barra acesso nao
 * autenticado; o getUser aqui e defense-in-depth e hidrata o e-mail da sessao.
 */
export default async function CockpitHomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const sessionUser = { email: user.email ?? "" };
  const conexoes = await loadConexoesFontes();

  return (
    <SessionProvider user={sessionUser}>
      <CockpitShell user={sessionUser} conexoes={conexoes}>
        <CockpitView />
      </CockpitShell>
    </SessionProvider>
  );
}
