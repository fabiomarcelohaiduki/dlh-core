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
  // A origem do callback acompanha o host REAL da requisicao (suporta acesso
  // via localhost e via IP da LAN). So cai no NEXT_PUBLIC_APP_URL se nem o
  // header origin nem o host estiverem disponiveis.
  const requestHost = hdrs.get("x-forwarded-host") ?? hdrs.get("host");
  const requestProto = hdrs.get("x-forwarded-proto") ?? "http";
  const origin =
    hdrs.get("origin") ??
    (requestHost ? `${requestProto}://${requestHost}` : undefined) ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000";

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
 *
 * Tem de rodar no servidor: os cookies de sessão são httpOnly (forçados no
 * middleware), inacessíveis ao client browser — só o server client consegue
 * expirá-los. Por isso os botões "Sair" delegam para esta action em vez de
 * chamar signOut no client (que deixaria o cookie vivo e o middleware
 * devolveria /login -> /dashboard).
 *
 * `redirectTo` permite ao logout por inatividade voltar com o aviso honesto
 * (/login?reason=expired); só destinos /login são aceitos.
 */
export async function logout(redirectTo: string = "/login"): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  redirect(redirectTo.startsWith("/login") ? redirectTo : "/login");
}
