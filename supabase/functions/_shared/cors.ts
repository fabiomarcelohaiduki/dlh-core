// =====================================================================
// _shared/cors.ts
// Cabecalhos CORS e tratamento de preflight reutilizados pelas Edge Functions.
// =====================================================================

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

/**
 * Responde ao preflight OPTIONS. Retorna null quando nao e preflight,
 * deixando o handler seguir o fluxo normal.
 */
export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}
