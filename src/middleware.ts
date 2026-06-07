import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Aplica a todas as rotas exceto:
     * - _next/static, _next/image (assets)
     * - favicon e arquivos estaticos comuns
     * - /auth/callback (handler publico do OAuth)
     * - /proxy (proxy das Edge Functions: valida a sessao no proprio handler;
     *   o getUser() de rede do middleware seria um round-trip redundante)
     */
    "/((?!_next/static|_next/image|favicon.ico|auth/callback|proxy/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
