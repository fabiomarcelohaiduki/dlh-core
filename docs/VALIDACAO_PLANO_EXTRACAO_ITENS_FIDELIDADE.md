# Relatório de validação — PLANO_EXTRACAO_ITENS_FIDELIDADE.md

> Auditoria cética contra o código real (dlh-core @ `baab507` + lionclawv1.0). Read-only: nenhum arquivo de produção alterado.
> Data: 2026-06-20. Método: leitura linha-a-linha dos arquivos citados nos dois repositórios.

## Veredito final

**PRONTO COM RESSALVAS.** O plano é, na maior parte, **factualmente correto** — quase todas as referências de código, premissas de negócio e descrições de schema conferem com o repositório. Porém há **um bloqueio arquitetural real** (recall do Effecti colocado na Edge errada) e **dois riscos de implementação não tratados** (atomicidade do delete-then-insert sob bloqueio; estado terminal `recall_incompleto` sem caminho de re-enfileiramento na Sprint 1) que precisam ser corrigidos **antes** de implementar a Sprint 1 como escrita. Detalhes na lista priorizada.

---

## 1) Tabela de referências verificadas

Legenda: **✅ CONFIRMADA** · **🟡 IMPRECISA** (existe perto / pequeno desvio de linha) · **❌ FALSA**.

| # | Referência do plano | Status | Constatação (arquivo:linha real) |
|---|---|---|---|
| 1 | `v1-documento-itens-gravar` l.106 `authenticateV1` + `TRIAGEM_WRITE_SCOPE` | ✅ | Exato, l.106. |
| 2 | …zod l.53-90 (`descricao` ≤20k, `fonte_descricao∈{tecnica,portal}`, qtd/preço numéricos opcionais, `lista_origem` livre) | ✅ | `itemSchema` l.53-68, `bodySchema` l.70-90. |
| 3 | …máquina de estados l.124-190 (`extraido`/`sem_itens`/`ignorado` terminais; `erro` transitório; teto `TETO_TENTATIVAS=3`→`inobtenivel`) | ✅ | Lógica l.124-190; teto l.47. |
| 4 | …retorna ids inseridos l.192-200 | ✅ | `return jsonResponse({…itens:itensInseridos})` l.192-200. |
| 5 | …delete-then-insert por `documento_id` (idempotência) | ✅ | delete l.146-152; insert l.173-176. |
| 6 | …**não valida fidelidade nenhuma hoje** | ✅ | Não há leitura de verbatim, grep nem soma. Confirmado. |
| 7 | Apêndice S1.2: checagem de existência l.112-122 faz `select("id, itens_tentativas")` | ✅ | Exato l.112-116. |
| 8 | …parse do body l.108; insert l.160-182; map de rows l.161-172; update status l.184-190 | ✅ | Todos exatos. |
| 9 | MCP `acervo-triagem`: "501 linhas" | 🟡 | São **502** linhas. Trivial. |
| 10 | …4 tools: `triagem_fila` l.102, `documento_itens_gravar` l.341, `triagem_veredito` l.235, `politica_participacao` l.439 | ✅ | Todos exatos. |
| 11 | …endpoints `/v1` l.48/49/50/51 | ✅ | FILA l.48, VEREDITO l.49, ITENS_GRAVAR l.50, POLITICA l.51. |
| 12 | …2 envs `DLH_ACERVO_API_KEY`/`DLH_TRIAGEM_WRITE_KEY` (cabeçalho l.38-41) | ✅ | Comentário l.38-41; consts l.46-47 (`lia_sk_`/`lia_tw_`). |
| 13 | …`callEdge` l.59-97 (Bearer, timeout 20s) | ✅ | l.59; `REQUEST_TIMEOUT_MS=20_000` l.52; Bearer l.71. |
| 14 | …zod por item l.373-385; body POST montado l.399-401 (só `documento_id`/`status`/`itens`/`motivo`) | ✅ | Exatos. |
| 15 | …MCP repassa cada aviso inteiro dentro de `itens` l.212 (logo `piso_effecti` dentro do aviso = sem mudança no MCP) | ✅ | `JSON.stringify({…itens…})` l.212. Raciocínio correto. |
| 16 | …"validação no MCP: NENHUMA além do zod de formato" (pass-through) | ✅ | `callEdge` só faz `fetch`; nenhuma trava. |
| 17 | `documentos-ingerir.persistirItens()` ~l.358-401, grava `itens_status='extraido'` | 🟡 | Função real **l.368-400** (faixa imprecisa); comportamento correto: delete+insert e `update itens_status='extraido'` (l.397). |
| 18 | …`enriquecerItensBestEffort()` ~l.404+, só grava se ainda `pendente` | ✅ | Função l.409; guarda `itens_status==="pendente"` l.421. |
| 19 | `extrair-anexos.mjs`: campo `itens` l.493-514 | ✅ | `let itens` l.493; anexado l.513. |
| 20 | …`baab507` removeu o ramo `r.ext==="pdf"` (PDF→`pendente`, DOCX→determinístico) | ✅ | Estado atual: só `ext==="docx"`→`extrairItensDocx` (l.494-496); sem ramo/import de PDF. `git show baab507` confere (−14/+10). |
| 21 | `extrair-itens.mjs` = parser célula-a-célula do `word/document.xml` | ✅ | Confirmado. |
| 22 | `extrair-itens-pdf.mjs` exporta `extrairItensPdfBytes`, coordenada `transform[4]/[5]`, **dois portões** (1..N contígua + confiança estrutural) | ✅ | Export l.206; coords l.48; gates l.165-172. |
| 23 | `effecti-connector.ts` l.620-635: `CAMPOS_VOLATEIS_HASH` inclui `itensEdital` | 🟡 | Const real **l.631-636**; `"itensEdital"` l.635. Conteúdo confere. |
| 24 | …comentário "itensEdital é o subconjunto que casou a palavra (nunca a lista completa)" | ✅ | Quase literal, l.627-629. |
| 25 | …`itensEdital` mora em `avisos.payload_bruto` (jsonb), sem coluna própria | ✅ | `payload_bruto` l.569/726; leitura via `payload_bruto->itensEdital`. |
| 26 | `automacao-aviso-itens.ts`: `ItensEditalRow` l.126-130 (`item`, `produtoLicitadoSemTags`) | ✅ | l.127-130. |
| 27 | …`marcarEffecti()` l.178-196 cruza por número **OU** `normDesc`; só hint (badge) | ✅ | l.192-194; não trava nada. |
| 28 | …`normDesc` = prefixo 30 chars, sem acento/pontuação | 🟡 | l.163-170: correto, **mas também remove espaços e qualquer não-alfanumérico** (`[^a-z0-9]`), não só pontuação. |
| 29 | Migration `20260618130000_documento_itens.sql`: colunas de `documento_itens`; sem coluna de suspeito/validado | ✅ | l.35-59. Tudo confere. |
| 30 | …CHECK de `documentos.itens_status` l.78-81 = `('pendente','extraido','sem_itens','erro','inobtenivel','ignorado')` | ✅ | Exato. `inobtenivel`/`ignorado` **já no original** (não foram adicionados depois). |
| 31 | …nome da constraint provável `documentos_itens_status_check` | 🟡 | CHECK é **inline sem nome**; o autogerado segue o padrão `documentos_itens_status_check` (provável), mas **só confirmável no banco vivo**. O plano já pede essa confirmação. |
| 32 | `documentos.texto` = verbatim (camada 1), migration `20260608130000` l.37 | ✅ | l.37 `texto text -- conteudo extraido (camada 1, verbatim)`. |
| 33 | RPC `ler_documento` `20260615240000` paginada `[offset,+limite)`, até 200k/página | ✅ | l.22-49; `least(…,200000)`. SECURITY DEFINER, só service_role. |
| 34 | `triagem_item_matches` `20260619180000`: match item×produto **por aviso**, `score`+`produto_nome` snapshot | ✅ | UNIQUE `(aviso_id, documento_item_id)`; delete-then-insert por aviso no veredito. |
| 35 | `triagem_match_feedback` `20260619200000`: fila humana, escopo **MATCH** (não extração), nasce `pendente`, ações `corrigir/remover/adicionar` | ✅ | Confirmado integralmente. |
| 36 | `20260618170000`: removeu `busca_produtos_por_documento`; `politica_participacao(nivel,escopo_id)` → UNIQUE | ✅ | DROP FUNCTION + `…_nivel_escopo_key`. |
| 37 | `instrucoes_operacionais` entra na fila — `triagem-fila.ts` l.116, 637, 657 | ✅ | Interface l.116; select l.637; mapeamento l.657. |
| 38 | S1.3: `selectCols` l.591-593 / 613-615 / 741-743 puxam só `uf` do `payload_bruto` via arrow | ✅ | Três sites confirmados; padrão de arrow-alias confirmado (l.782-784). |
| 39 | S1.3: `interface AvisoRow` l.262 | ✅ | l.262-272. |
| 40 | S1.3: `interface TriagemFilaItem` l.~176-182 + montagem do envelope l.438-451 | 🟡 | Interface real **l.171-190** (176-182 cai no meio); push do envelope l.438-451 ✅. |
| 41 | A.2/C.4: `precisa_ocr` migration `20260615330000` | ✅ | Confirmado — porém em **`documento_vinculos.status_extracao`** (não em `documentos`). |
| 42 | C.3/S1.2: reusar `parseNumeroBr` "do parser determinístico" | 🟡 | Existe em **`extrair-itens.mjs` l.50** (parser **DOCX**, não o PDF). É script **Node (.mjs)** — não importável direto na Edge **Deno**; reuso = reimplementar/extrair p/ `_shared`. |
| 43 | C.3/S1.2: reusar `normDesc` "de automacao-aviso-itens.ts" | 🟡 | `normDesc` está **dentro** da Edge `automacao-aviso-itens/index.ts` l.163, **não em `_shared`** → reuso exige extrair p/ `_shared` antes. |

**Resumo:** 0 referências FALSAS. As 🟡 são desvios pequenos de linha/localização ou imprecisões de "reuso" — nenhuma invalida o raciocínio, mas as #42/#43 mudam o esforço (porte cross-runtime, não import) e a #40/#17/#23 devem ser corrigidas para o implementador não procurar no lugar errado.

---

## 2) Premissas de negócio/arquitetura

| Premissa | Veredito | Evidência |
|---|---|---|
| `itensEdital` é o subconjunto filtrado por palavra-chave, **não** a lista completa | ✅ Verdadeira | Comentário literal em `effecti-connector.ts` l.627-629; `CAMPOS_VOLATEIS_HASH` l.635. |
| MCP `acervo-triagem` é pass-through, sem validação além do zod de formato | ✅ Verdadeira | `callEdge` só faz `fetch`+`JSON`; nenhuma trava de fidelidade/recall/soma. |
| Verbatim para grep existe em `documentos.texto`, lido via `acervo_ler_documento` | ✅ Verdadeira | `documentos.texto` l.37; RPC `ler_documento`; Edge `v1-acervo-ler-documento` existe. |
| DOCX grava `extraido` direto; PDF desligado (`baab507`) | ✅ Verdadeira | `extrair-anexos.mjs` só docx; `git show baab507` confere; `persistirItens` grava `extraido`. |
| `triagem_match_feedback` é fila de **match item×produto**, não de extração | ✅ Verdadeira | Migration `20260619200000` (escopo produto/SKU). |

Todas as cinco premissas centrais do plano **se sustentam no código**.

---

## 3) Coerência da Sprint 1 (apêndice)

**Migrations (S1.1) — compatíveis e idempotentes.**
- As 3 colunas novas em `documento_itens` (`item_estado`/`item_origem`/`suspeito_motivo`) são puramente aditivas; `default 'revisado'` mantém as linhas DOCX coerentes (decisão 5). ✅
- A extensão do CHECK de `itens_status` por **drop+add idempotente** é a abordagem correta (CHECK não aceita `if not exists`). ✅ **Ressalva já levantada pelo próprio plano**: a constraint é **inline sem nome** — o nome `documentos_itens_status_check` é o padrão provável, mas **confirme no banco** (`\d public.documentos` / `pg_constraint`) antes de rodar o `drop`. Existe **uma só** CHECK sobre a coluna; nenhuma migration posterior a `20260618130000` a altera — então não há concorrência de constraints.
- `documento_item_suspeitas` com RLS habilitada e sem policy (service_role bypassa) espelha `triagem_item_matches`/`documento_itens`. ✅ **Nota menor:** a Lia lê o substrato por `substrato_sql` (read-only); uma tabela RLS-on sem policy **não será visível** a esse papel se ele não tiver BYPASSRLS. Como o plano roteia a fila de suspeitas por Edge/cockpit (não por SQL da Lia), isso é provavelmente **intencional** — apenas registre.

**Travas na Edge (S1.2):**
- **Fidelidade (grep reverso + conferência de soma): implementável aqui.** `documentos.texto` está disponível no mesmo ponto e a ampliação do `select` (l.112-116) para incluir `texto` é trivial. A trava é **per-documento**, casando com a natureza per-documento da Edge. ✅
- **Validador de recall do Effecti como bloqueio duro nesta Edge: NÃO é cleanly implementável** — ver bloqueio B1 abaixo. O próprio plano hesita (S1.2 passo 2/5: "casa melhor no `triagem_veredito`"), mas a **Sprint 1 e os critérios de aceite S1.5 ainda o colocam na Edge per-documento**. Inconsistência interna que precisa ser resolvida.

**Conflitos com RLS / triggers / "Lia nunca usa SQL bruto / consome via /v1":** não há conflito de fundo. As escritas seguem server-side com `service_role`; o `piso_effecti` vai na **resposta** da fila (não SQL da Lia); as correções humanas vivem na fila via Edge. ✅

---

## 4) Buracos e riscos priorizados (o que corrigir antes de implementar)

### 🔴 BLOQUEIO

**B1 — O recall do Effecti não pode ser bloqueio duro na Edge per-documento (a trava está no lugar errado).**
A Edge `v1-documento-itens-gravar` recebe **só `documento_id`** (corpo l.70-74; MCP l.399-401). Mas:
- um **aviso tem N documentos**, e um **item do `itensEdital` pode estar em OUTRO documento** do mesmo aviso (o próprio plano admite isso em E/bordas: *"o piso do Effecti é por aviso e pode casar itens de qualquer documento do aviso"*);
- um **documento é compartilhado por N avisos** (dedup global por `effecti_id`/hash), cada um com um `itensEdital` **diferente** (perfis de palavra-chave distintos).

Logo, exigir "todo item do `itensEdital` aparece **nesta** lista de **um** documento" gera `recall_incompleto` **falso** sempre que o aviso tem mais de um edital/anexo — podendo **travar a gravação em loop**. O lugar natural do recall por-aviso é o `v1-triagem-veredito`, que **já é per-aviso e já tem `rebaixado_por_recall`** (`temDocExtraivelSemItens` sobre todos os docs do `effecti_id`, l.494-498) — precedente pronto.
*Correção:* mover a validação de recall do Effecti para `triagem_veredito` (ou um passo dedicado per-aviso que agregue os itens de TODOS os documentos do aviso). Manter na Edge `documento_itens_gravar` **apenas a fidelidade** (grep/soma), que é genuinamente per-documento. Ajustar a Sprint 1 e os aceites S1.5 conforme.

> Observação sobre a opção (a) de S1.2 passo 2 ("estender o body com `aviso_id`"): isso **exige mudar o MCP** (a tool `documento_itens_gravar` não envia `aviso_id`; zod l.370-387, body l.399-401) — contradiz o "não toca o MCP". Só a opção (b) (servidor resolve via `documento_vinculos`) é MCP-free, e ela é justamente a que sofre da ambiguidade de B1.

### 🟠 ALTO

**B2 — Atomicidade: o delete-then-insert apaga itens bons ANTES de validar; um bloqueio deixa o documento vazio.**
Hoje o fluxo é `delete` (l.146-152) → `insert` (l.173). O plano insere as travas "antes do insert (l.160-182)", **depois** do delete. Se a trava de recall (ou qualquer falha) bloquear após o delete, os itens anteriormente gravados já foram **destruídos** e nada é reinserido — perda de dados, e não há transação entre as chamadas (cliente Supabase JS faz requests separados). *Correção:* validar **antes de qualquer delete**, ou encapsular delete+insert+update numa **RPC/transação** Postgres. Esse ponto não é tratado no plano.

**B3 — `recall_incompleto` é criado na Sprint 1 sem caminho de re-enfileiramento.**
A Sprint 1 introduz o estado bloqueante `recall_incompleto`, mas o re-surface para a Lia (prompt) é só Sprint 2 e a fila/tela é Sprint 3. A `triagem-fila` entrega docs com seu `itens_status`, porém a Lia hoje só age sobre `pendente` (prompt atual). Resultado: docs travados em `recall_incompleto` **sem mecanismo de reprocesso** até a Sprint 2/3 → possível dead-end. *Correção:* se B1 mover o recall para o veredito, B3 some em grande parte; caso contrário, incluir na Sprint 1 a reabertura (ex.: tratar `recall_incompleto` como reprocessável na seleção da fila, espelhando `erro`).

### 🟡 MÉDIO

**B4 — `parseNumeroBr`/`normDesc` não são reutilizáveis por import.** `parseNumeroBr` vive em script **Node** (`extrair-itens.mjs`, e é do parser **DOCX**, não do PDF como o texto sugere); `normDesc` vive **dentro** da Edge `automacao-aviso-itens`. Reuso na Edge `v1-documento-itens-gravar` (Deno) exige **extrair para `_shared/`** ou reimplementar. Some ~0,5 dia ao esforço estimado e não está no plano.

**B5 — Carregar `documentos.texto` inteiro no hot path do write.** Documentos chegam a ~4,4M chars (comentário em `ler_documento`). Puxar o `texto` completo por POST para o grep adiciona latência/memória à gravação. *Mitigação:* limitar/streamar a janela, ou indexar a busca dos números — o plano assume o texto inteiro sem ressalva de tamanho.

**B6 — A reativação do parser de PDF rende rascunho pobre justamente no caso difícil.** Os dois portões do `extrair-itens-pdf.mjs` **retornam `[]`** quando a numeração não é contígua ou a confiança estrutural é baixa (l.165-172) — ou seja, em tabela com coluna de código/multi-linha (o caso de `baab507`) o rascunho vem **vazio**, sem servir de checklist exatamente onde mais se precisa. O ganho de recall do Estágio 1 fica restrito a PDFs de tabela limpa (que já funcionavam). Reavaliar se o custo de reativar compensa, ou afrouxar os portões para "rascunho" (já que ele não decide mais).

### 🟢 BAIXO / registrar
- **Design Lock:** badges/tela de fila no cockpit exigem revisar `docs/.../design/manifest.json` (`locked:true`) — o plano já registra (Sprint 3).
- **Paginação de itens (page 2+):** o envelope reduzido de `buildItensPagina` (l.570-587) não carrega `piso_effecti`; ok, pois o piso é contexto de aviso entregue na página 1, mas vale documentar para o implementador não esperá-lo nas páginas seguintes.
- **`item_origem` por zod:** correto que sem adicionar o campo ao zod do MCP (l.373-385) ele seria **silenciosamente descartado** (zod strip de chaves desconhecidas) — a conclusão do plano ("precisa de 1 campo opcional no MCP e na Edge") está certa.

---

## 5) Conclusão

O plano demonstra **leitura real e fiel do código** — a esmagadora maioria das ~43 referências confere, todas as 5 premissas de negócio se sustentam, e o desenho de schema da Sprint 1 é compatível e idempotente. As correções necessárias antes de codar a Sprint 1, em ordem:

1. **B1 (bloqueio):** tirar o recall do Effecti da Edge per-documento; aplicá-lo per-aviso no `triagem_veredito` (ou passo dedicado). Reescrever o escopo da Sprint 1 e os aceites S1.5.
2. **B2 (alto):** validar antes do delete ou usar transação/RPC — não destruir itens bons num bloqueio.
3. **B3 (alto):** garantir caminho de reprocesso para `recall_incompleto` na mesma sprint que o cria (mitigado por B1).
4. **B4/B5/B6 (médio):** ajustar esforço para o porte de `parseNumeroBr`/`normDesc`, limitar o verbatim no hot path, e recalibrar a expectativa de ganho do rascunho de PDF.

Resolvidos B1–B3, a Sprint 1 fica **pronta para implementar**.
