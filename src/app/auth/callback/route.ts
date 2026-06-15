import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { edgeAuthHeaders, functionsUrl } from "@/lib/supabase/functions";

/**
 * Callback do OAuth Google. Troca o `code` pela sessão (cookies httpOnly) e
 * valida a allowlist consumindo POST /auth/google (Edge Function auth-google,
 * modo callback). Distingue:
 *   - sucesso        -> redireciona ao deep-link (next) ou /dashboard
 *   - acesso negado  -> 403 (ativo=false ou fora da allowlist): /login?error=denied
 *   - falha técnica  -> /login?error=oauth
 *   - cancelado/sem code -> /login (idle, sem erro)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  // A origem dos redirects acompanha o host REAL da requisicao (suporta acesso
  // via localhost e via IP da LAN). request.nextUrl.origin resolve para
  // localhost no next dev, ignorando o host -> derivamos do header host.
  const requestHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const requestProto = request.headers.get("x-forwarded-proto") ?? "http";
  const origin = requestHost
    ? `${requestProto}://${requestHost}`
    : request.nextUrl.origin;
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error");
  const next = searchParams.get("next");
  const safeNext = next && next.startsWith("/") ? next : "/dashboard";

  // Usuário cancelou o popup/redirect: volta ao login em estado idle.
  if (oauthError) {
    return NextResponse.redirect(new URL("/login", origin));
  }

  if (!code) {
    return NextResponse.redirect(new URL("/login", origin));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data?.session) {
    return NextResponse.redirect(new URL("/login?error=oauth", origin));
  }

  // Valida a allowlist reutilizando a Edge Function auth-google (modo callback).
  const headers = edgeAuthHeaders(data.session.access_token);
  headers.set("Content-Type", "application/json");

  try {
    const res = await fetch(functionsUrl("auth-google"), {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "google" }),
    });

    if (res.ok) {
      return NextResponse.redirect(new URL(safeNext, origin));
    }

    // 403 -> conta não autorizada / ativo=false. A função já fez signOut
    // server-side; limpamos também os cookies locais.
    await supabase.auth.signOut({ scope: "local" });
    if (res.status === 403) {
      return NextResponse.redirect(new URL("/login?error=denied", origin));
    }
    return NextResponse.redirect(new URL("/login?error=oauth", origin));
  } catch {
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.redirect(new URL("/login?error=oauth", origin));
  }
}
