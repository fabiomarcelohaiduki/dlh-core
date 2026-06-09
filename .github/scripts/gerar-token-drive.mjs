// =====================================================================
// .github/scripts/gerar-token-drive.mjs
// USO UNICO / LOCAL — gera o REFRESH TOKEN do Drive (opcao A, decisao Fabio
// 2026-06-08). Roda na maquina do Fabio, abre o navegador para ele autorizar
// e imprime o refresh_token SO NO TERMINAL dele (nunca trafega pelo chat).
// Depois ele cola os 3 secrets no GitHub Actions.
//
// NAO faz parte do fluxo de CI; e ferramenta de bootstrap. Sem segredo no
// arquivo: le client_id/secret de variaveis de ambiente que voce exporta na
// MESMA sessao do terminal antes de rodar:
//
//   export GOOGLE_OAUTH_CLIENT_ID="...apps.googleusercontent.com"
//   export GOOGLE_OAUTH_CLIENT_SECRET="..."
//   node .github/scripts/gerar-token-drive.mjs
//
// Fluxo: OAuth 2.0 com loopback (http://localhost:PORT), permitido para
// clients do tipo "Desktop". Escopo drive.readonly (minimo: listar + baixar).
// access_type=offline + prompt=consent garantem que o Google devolva o
// refresh_token (de longa duracao) alem do access_token.
// =====================================================================

import http from "node:http";
import { spawn } from "node:child_process";

const PORT = 53682; // porta loopback fixa (registrar como redirect nao e preciso p/ Desktop)
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const CLIENT_ID = (process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "ERRO: exporte GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET (do Client Desktop)\n" +
      "antes de rodar. Ex (bash):\n" +
      '  export GOOGLE_OAUTH_CLIENT_ID="...apps.googleusercontent.com"\n' +
      '  export GOOGLE_OAUTH_CLIENT_SECRET="..."',
  );
  process.exit(2);
}

function abrirNavegador(url) {
  const plat = process.platform;
  // win32: usar PowerShell Start-Process. O `cmd start` corta a URL no primeiro
  // `&` (separador de comandos do cmd), gerando uma URL OAuth incompleta
  // (response_type ausente -> Erro 400 invalid_request).
  const cmd = plat === "win32" ? "powershell" : plat === "darwin" ? "open" : "xdg-open";
  const args =
    plat === "win32" ? ["-NoProfile", "-Command", `Start-Process '${url}'`] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch (_) {
    // sem navegador automatico: o usuario abre o link manualmente.
  }
}

async function trocarCodePorTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`troca de code falhou (${res.status}): ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const authUrl =
  `${AUTH_URL}?` +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const erro = url.searchParams.get("error");

  if (erro) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Autorizacao negada: ${erro}. Pode fechar esta aba.`);
    console.error(`\nERRO: autorizacao negada (${erro}).`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const tokens = await trocarCodePorTokens(code);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>Pronto.</h2><p>Refresh token gerado. Pode fechar esta aba e voltar ao terminal.</p>");

    if (!tokens.refresh_token) {
      console.error(
        "\nATENCAO: o Google NAO devolveu refresh_token (provavelmente ja havia consentimento ativo).\n" +
          "Revogue o acesso em https://myaccount.google.com/permissions e rode de novo,\n" +
          "ou o prompt=consent ja deveria forcar — confira o Client Desktop.",
      );
      server.close();
      process.exit(1);
    }

    console.log("\n=====================================================");
    console.log(" REFRESH TOKEN DO DRIVE (copie e guarde como secret):");
    console.log("=====================================================\n");
    console.log(tokens.refresh_token);
    console.log("\n-----------------------------------------------------");
    console.log("Cadastre estes 3 secrets no GitHub Actions do repo dlh-core:");
    console.log("  GOOGLE_OAUTH_CLIENT_ID      = (o mesmo client_id usado aqui)");
    console.log("  GOOGLE_OAUTH_CLIENT_SECRET  = (o mesmo client_secret usado aqui)");
    console.log("  GOOGLE_OAUTH_REFRESH_TOKEN  = (o valor acima)");
    console.log("-----------------------------------------------------\n");
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Falha ao trocar o code por tokens. Veja o terminal.");
    console.error(`\nERRO: ${err?.message ?? err}`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log("Abrindo o navegador para autorizar o acesso ao Drive (somente leitura)...");
  console.log("Se nao abrir sozinho, cole este link no navegador:\n");
  console.log(authUrl.toString());
  console.log("");
  abrirNavegador(authUrl.toString());
});
