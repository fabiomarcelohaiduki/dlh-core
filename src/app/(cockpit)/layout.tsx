import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CockpitShell } from "@/components/cockpit/cockpit-shell";
import { SessionProvider } from "@/components/auth/session-provider";
import { loadConexoesFontes } from "@/lib/conexoes-fontes";

/**
 * Layout do route group (cockpit): grid sidebar + conteúdo. A tela /login
 * fica fora deste grupo. Defense in depth: além do middleware, garante a
 * sessão no servidor antes de renderizar o shell.
 */
export default async function CockpitLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
        {children}
      </CockpitShell>
    </SessionProvider>
  );
}
