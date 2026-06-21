// =====================================================================
// effecti-painel-itens
// GET ?effecti_id=<id> -> lista COMPLETA de itens do edital pelo painel web
// (recall total). Superficie de teste e disparo manual do coletor; o gate de
// recall da triagem (passo 3) importa coletarItensPainel direto do _shared,
// sem passar por esta Edge.
//
// Sessao do cockpit (verify_jwt default = true); sem entrada no config.toml.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { coletarItensPainel } from "../_shared/effecti-painel.ts";

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");
    await requireAuthorizedUser(req);

    const effectiId = new URL(req.url).searchParams.get("effecti_id")?.trim();
    if (!effectiId) {
      throw new HttpError(422, "effecti_id_obrigatorio", "informe ?effecti_id=<id>");
    }

    const coleta = await coletarItensPainel(effectiId);
    return jsonResponse(coleta, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "effecti-painel-itens" });
  }
}

getEnv();
Deno.serve(handler);
