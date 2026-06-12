import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { edgeAuthHeaders, functionsUrl } from "@/lib/supabase/functions";

/**
 * Proxy server-side para as Edge Functions.
 *
 * A sessao do usuario vive em cookies httpOnly (RNF de seguranca), portanto o
 * browser NAO consegue ler o access token para autenticar chamadas diretas as
 * funcoes. Este Route Handler roda no servidor, le a sessao via cookie httpOnly
 * e encaminha a requisicao para a Edge Function com o Bearer do usuario. O RLS
 * do usuario autorizado continua sendo aplicado em cada endpoint.
 *
 * Esta rota e excluida do middleware (ver matcher em src/middleware.ts): a
 * sessao ja e validada aqui via getSession() e o JWT e revalidado pela propria
 * Edge Function, dispensando o getUser() de rede do middleware.
 */
async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    return NextResponse.json(
      { error: "invalid_session", message: "sessao ausente ou expirada" },
      { status: 401 },
    );
  }

  const target = `${functionsUrl(
    path.map((seg) => encodeURIComponent(seg)).join("/"),
  )}${req.nextUrl.search}`;

  const headers = edgeAuthHeaders(session.access_token);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  const method = req.method;
  // arrayBuffer preserva uploads binarios (multipart/form-data de imagens) que
  // req.text() corromperia; tambem encaminha corpos JSON normalmente.
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await req.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body });
  } catch {
    return NextResponse.json(
      { error: "upstream_unreachable", message: "Edge Function inacessivel" },
      { status: 502 },
    );
  }

  const respBody = await upstream.text();
  const outHeaders = new Headers();
  const respContentType = upstream.headers.get("content-type");
  if (respContentType) outHeaders.set("content-type", respContentType);

  return new NextResponse(respBody, {
    status: upstream.status,
    headers: outHeaders,
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
