import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/** Rotas do cockpit protegidas por sessao (criterio da sprint). */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/execucoes",
  "/erros",
  "/edital",
  "/fontes",
  "/ingestao",
  "/api",
];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Refresca a sessao Supabase a cada request (via cookies httpOnly) e aplica
 * a protecao de rotas:
 *  - sessao ausente/expirada em rota protegida -> /login (preserva deep-link)
 *  - sessao valida acessando /login -> /dashboard
 *  - raiz "/" -> /dashboard
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            // Força httpOnly: a sessão fica inacessível a scripts no browser.
            supabaseResponse.cookies.set(name, value, { ...options, httpOnly: true }),
          );
        },
      },
    },
  );

  // IMPORTANTE: getUser() valida o token no servidor (refresh inclusive),
  // diferente de getSession() que apenas le o cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;

  // Raiz redireciona direto para o dashboard.
  if (pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = user ? "/dashboard" : "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Sessao ausente/expirada em rota protegida -> login com deep-link.
  if (!user && isProtected(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const redirectTo = `${pathname}${search}`;
    if (redirectTo && redirectTo !== "/login") {
      url.searchParams.set("redirectTo", redirectTo);
    }
    return NextResponse.redirect(url);
  }

  // Sessao valida acessando /login -> dashboard.
  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
