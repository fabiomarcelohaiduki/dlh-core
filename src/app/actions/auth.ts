"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type LoginError = { error: "oauth" };

/**
 * action-login-google -> inicia o fluxo OAuth do Google (semântica POST
 * /auth/google, modo iniciação). Usa o server client do @supabase/ssr para
 * que o code_verifier (PKCE) seja gravado nos cookies httpOnly do browser,
 * permitindo a troca segura do código no /auth/callback.
 *
 * Retorna { error: "oauth" } em falha técnica do OAuth (rede/config); em
 * sucesso, redireciona o browser para o provedor (Google).
 */
export async function loginWithGoogle(
  redirectTo?: string,
): Promise<LoginError | void> {
  const supabase = await createClient();
  const hdrs = await headers();
  const origin =
    hdrs.get("origin") ??
    process.env.NEXT_PUBLIC_APP_URL ??
    `https://${hdrs.get("host") ?? ""}`;

  const callbackUrl = new URL("/auth/callback", origin);
  if (redirectTo && redirectTo.startsWith("/")) {
    callbackUrl.searchParams.set("next", redirectTo);
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackUrl.toString(),
      queryParams: { access_type: "offline", prompt: "consent" },
    },
  });

  if (error || !data?.url) {
    return { error: "oauth" };
  }

  redirect(data.url);
}

/**
 * Logout server-side: revoga a sessão local e limpa os cookies httpOnly.
 */
export async function logout(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
