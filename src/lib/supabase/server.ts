import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Cliente Supabase para Server Components, Route Handlers e Server Actions.
 * Le e grava a sessao via cookies httpOnly. O `set` pode lancar quando
 * chamado de um Server Component (read-only) — nesse caso o refresh fica
 * a cargo do middleware.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              // Força httpOnly: a sessão fica inacessível a scripts no browser.
              cookieStore.set(name, value, { ...options, httpOnly: true });
            });
          } catch {
            // Chamado a partir de um Server Component: ignorar.
            // O middleware (updateSession) cuida do refresh dos cookies.
          }
        },
      },
    },
  );
}
