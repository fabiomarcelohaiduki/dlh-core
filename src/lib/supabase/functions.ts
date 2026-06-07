/**
 * Helpers compartilhados para chamar as Edge Functions Supabase a partir do
 * servidor (Route Handlers). Centraliza a base `functions/v1` e os headers de
 * autenticacao (apikey anon + Bearer do usuario), evitando duplicar esses
 * literais entre o proxy e o callback do OAuth.
 */
const FUNCTIONS_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL!}/functions/v1`;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** URL de uma Edge Function pelo nome/segmentos ja montados do path. */
export function functionsUrl(path: string): string {
  return `${FUNCTIONS_BASE}/${path}`;
}

/** Headers de chamada autenticada a uma Edge Function (apikey anon + Bearer). */
export function edgeAuthHeaders(accessToken: string): Headers {
  const headers = new Headers();
  headers.set("apikey", ANON);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
