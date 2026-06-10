import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CockpitShell } from "@/components/cockpit/cockpit-shell";
import { SessionProvider } from "@/components/auth/session-provider";
import { conexaoFonteState, type FonteConexao } from "@/lib/status";

/** Linha de public.fontes para o indicador de conexao (sem o segredo). */
interface FonteConexaoRow {
  tipo: string;
  estado_conexao: string | null;
  token_cifrado: string | null;
}

/**
 * Hidratacao server-side (RLS) do estado de conexao das 4 fontes para o
 * indicador do topbar. Effecti/Nomus: conexao = credencial no Vault
 * (token_cifrado presente). Drive/Gmail: conta OAuth ligada (e-mail no
 * singleton). A cor (verde/vermelho/cinza) deriva via conexaoFonteState.
 */
async function loadConexoesFontes(): Promise<FonteConexao[]> {
  const supabase = await createClient();
  const [fontesRes, driveRes, gmailRes] = await Promise.all([
    supabase.from("fontes").select("tipo, estado_conexao, token_cifrado"),
    supabase.from("drive_conta").select("email").eq("id", true).maybeSingle(),
    supabase.from("gmail_conta").select("email").eq("id", true).maybeSingle(),
  ]);

  const rows = (fontesRes.data ?? []) as FonteConexaoRow[];
  const byTipo = (tipo: string) => rows.find((r) => r.tipo === tipo) ?? null;
  const effecti = byTipo("effecti");
  const nomus = byTipo("nomus");
  const gmail = byTipo("gmail");

  const driveEmail = (driveRes.data as { email: string | null } | null)?.email ?? null;
  const gmailEmail = (gmailRes.data as { email: string | null } | null)?.email ?? null;

  return [
    {
      tipo: "effecti",
      label: "Effecti",
      state: conexaoFonteState(effecti?.estado_conexao ?? null, Boolean(effecti?.token_cifrado)),
    },
    {
      tipo: "nomus",
      label: "Nomus",
      state: conexaoFonteState(nomus?.estado_conexao ?? null, Boolean(nomus?.token_cifrado)),
    },
    { tipo: "drive", label: "Drive", state: conexaoFonteState(null, Boolean(driveEmail)) },
    {
      tipo: "gmail",
      label: "Gmail",
      state: conexaoFonteState(gmail?.estado_conexao ?? null, Boolean(gmailEmail)),
    },
  ];
}

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
