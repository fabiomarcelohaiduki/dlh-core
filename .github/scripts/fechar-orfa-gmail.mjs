// =====================================================================
// .github/scripts/fechar-orfa-gmail.mjs
// CLEANUP da coleta Gmail. Roda num step if:always() do coletar-gmail.yml,
// DEPOIS da descoberta. Fecha como 'erro' qualquer execucao em_andamento da
// fonte gmail (via Edge gmail-execucao action='fechar-orfa').
//
// POR QUE: quando o GitHub CANCELA o run, o Node do descobrir-gmail.mjs morre
// por sinal (SIGTERM/SIGKILL) e o try/catch que fecharia a execucao nao roda
// -> execucao fica pendurada em_andamento (orfa) e trava o card/lock. Este step
// separado roda apos o cancelamento e auto-cura. No fim normal a execucao ja
// esta 'concluida' -> a action e no-op.
//
// SEGURANCA: o concurrency 'coletar-gmail' (cancel-in-progress:false) garante 1
// run de coleta Gmail por vez, entao toda em_andamento da gmail aqui e desta run
// (ou orfa de run anterior) -> seguro fechar.
//
// Env: SUPABASE_URL, CRON_DISPATCH_SECRET (obrigatorias), SUPABASE_ANON_KEY (opc).
// Best-effort: nunca derruba o job (sai 0 mesmo em falha).
// =====================================================================

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const CRON_SECRET = process.env.CRON_DISPATCH_SECRET;
const ANON = process.env.SUPABASE_ANON_KEY;

function headers() {
  const h = { "Content-Type": "application/json", "X-Cron-Secret": CRON_SECRET };
  if (ANON) {
    h["apikey"] = ANON;
    h["Authorization"] = `Bearer ${ANON}`;
  }
  return h;
}

async function main() {
  if (!SUPABASE_URL || !CRON_SECRET) {
    console.error("AVISO: SUPABASE_URL ou CRON_DISPATCH_SECRET ausente; cleanup ignorado.");
    return;
  }
  const url = `${SUPABASE_URL}/functions/v1/gmail-execucao`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ action: "fechar-orfa" }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`AVISO: gmail-execucao (fechar-orfa) falhou (${res.status}): ${text.slice(0, 200)}`);
    return;
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    // mantem text cru
  }
  console.log(`Cleanup Gmail: ${json?.fechadas ?? "?"} execucao(oes) orfa(s) fechada(s).`);
}

main().catch((err) => {
  console.error(`AVISO: cleanup orfa falhou: ${err?.message ?? err}`);
});
