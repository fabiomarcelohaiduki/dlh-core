# Plano de implementação — Extração de itens com fidelidade (número vs descrição)

> Análise e plano de sprints. Não altera código de produção. Baseado no estado real do repositório em `baab507` (2026-06-20).
> Refinado pelo Fábio (2026-06-20) com duas regras de negócio: **(1) Effecti como VALIDADOR DE RECALL** (piso garantido de itens, não fonte/esqueleto da lista) e **(2) extração em DOIS ESTÁGIOS** (rascunho determinístico → revisão da Lia contra o verbatim → trava server-side).
>
> Estratégia central: **fidelidade com recall total**. A Lia extrai a lista completa do PDF/TR (verbatim é canônico); o parser determinístico só dá um **rascunho** que ajuda no recall (nunca decide); o servidor valida fidelidade (cópia literal de número, conferência de soma) **e completude** (todo item do Effecti tem que aparecer na lista) antes de gravar como final.
>
> **A integração Lion ↔ dlh-core JÁ EXISTE e está cabeada** (MCP `acervo-triagem` em `lionclawv1.0`, 4 tools, 2 chaves do Vault). Este plano **incrementa sobre o que já roda** — não há integração, credencial nem MCP a criar. Ver a seção "Integração Lion ↔ dlh-core (estado atual)".
>
> **Desenho corrigido após auditoria (relatório `VALIDACAO_PLANO_EXTRACAO_ITENS_FIDELIDADE.md`, veredito PRONTO COM RESSALVAS — B1/B2/B3 aplicados):**
> - **FIDELIDADE (grep reverso + conferência de soma) → Edge per-documento `v1-documento-itens-gravar`.** Opera sobre o texto/itens daquele documento. É genuinamente per-documento.
> - **RECALL do Effecti (todo item do `itensEdital` tem que aparecer) → `v1-triagem-veredito`, per-aviso.** O piso é por-aviso e um item pode estar em qualquer documento do aviso; o veredito já agrega os docs por `effecti_id` e já tem o precedente `rebaixado_por_recall`. **Não** roda na Edge de gravar (geraria `recall_incompleto` falso quando o aviso tem >1 edital).
> - **ATOMICIDADE:** validar a lista **antes de qualquer delete** (validação pura) — ou encapsular delete+insert+update em RPC/transação — para nunca apagar itens bons e abortar.

---

## A) Estado atual do caminho de itens (mapa do código)

### A.1 Escrita dos itens — quem grava `documento_itens`

Há **dois caminhos de escrita**, ambos com `delete-then-insert por documento_id` (idempotência):

1. **Determinístico (DOCX), na ingestão.** `supabase/functions/documentos-ingerir/index.ts`, função `persistirItens()` (l. ~358-401) e `enriquecerItensBestEffort()` (l. ~404+). Os itens chegam anexados ao resultado da extração pelo GitHub Action `.github/scripts/extrair-anexos.mjs` (l. 493-514, campo `itens`), produzidos por `.github/scripts/extrair-itens.mjs` (parser célula-a-célula do `word/document.xml`). Ao persistir, vira `itens_status='extraido'`. `enriquecerItensBestEffort` só grava se o documento ainda está `pendente` (nunca sobrescreve itens já extraídos/decididos).

2. **LLM (a Lia), na triagem.** `supabase/functions/v1-documento-itens-gravar/index.ts` — `POST /v1-documento-itens-gravar`, autenticação `authenticateV1` com `TRIAGEM_WRITE_SCOPE` (l. 106), grava com `service_role`. Validação zod (l. 53-90): `descricao` obrigatória e integral (até 20k), `quantidade`/`preco_referencia` numéricos opcionais, `fonte_descricao ∈ {tecnica,portal}`, `lista_origem` livre. Máquina de estados (l. 124-190): `extraido` (≥1 item) / `sem_itens` / `ignorado` (terminais) / `erro` (transitório, incrementa `itens_tentativas`; no teto `TETO_TENTATIVAS=3` vira `inobtenivel`). Retorna os ids inseridos (l. 192-200) para o mesmo run referenciar `documento_item_id` no match.

   **Ponto-chave:** este Edge **não valida fidelidade nenhuma** hoje — confia integralmente no que a Lia postou.

### A.2 PDF foi desligado (o impasse de ontem)

Commit `baab507` ("desliga parser PDF determinístico na ingestão (só docx)"): em `extrair-anexos.mjs` o ramo `r.ext === "pdf"` saiu (l. 493-499 do diff). O parser `.github/scripts/extrair-itens-pdf.mjs` (extração por coordenada `transform[4]/[5]` via pdfjs, com dois portões de recall — numeração 1..N contígua e confiança estrutural) **continua no repo mas não é mais chamado**. Motivo declarado no commit: "acerta a numeração mas a descrição sai infiel em tabela com coluna de código / multi-linha". Logo: **PDF agora cai em `itens_status='pendente'` e a Lia extrai na triagem.** É exatamente o caso que a estratégia número-vs-descrição quer destravar.

### A.3 Onde mora o `itensEdital` do Effecti

- **Armazenamento:** `avisos.payload_bruto->itensEdital` (jsonb), capturado pelo conector Effecti. **NÃO** tem coluna própria.
- **Natureza (crítico):** é o **subconjunto que casou a palavra-chave do perfil, NUNCA a lista completa** — documentado em `effecti-connector.ts` l. 620-635 (`CAMPOS_VOLATEIS_HASH` inclui `itensEdital`, excluído do hash porque oscila entre chamadas idênticas). O comentário é explícito: *"itensEdital é o subconjunto que casou a palavra (nunca a lista completa) → o edital PDF é a fonte canônica dos itens"*.
- **Forma:** cada entrada tem ao menos `item` (number|string) e `produtoLicitadoSemTags` (string). Ver `automacao-aviso-itens/index.ts` interface `ItensEditalRow` (l. 126-130).
- **Uso hoje:** apenas **badge de prioridade no cockpit**. `automacao-aviso-itens.ts` → `marcarEffecti()` (l. 178-196) cruza por número OU por descrição normalizada (`normDesc`, prefixo de 30 chars sem acento/pontuação). É hint, não decisão. **O `itensEdital` NÃO é exposto à Lia no payload da fila** (`triagem-fila.ts` não o inclui).

### A.4 Prompt/método atual da Lia

Tudo vive em `triagem_agente_config.instrucoes_operacionais` (singleton, versionado, editável pelo cockpit) — migration `20260619150000_triagem_agente_instrucoes_operacionais.sql`. O shell do subagente no Lion é mínimo; o método vem do banco e entra no payload da fila (`triagem-fila.ts` l. 116, 637, 657). Passos 1-7. Já contém regras fortes de recall (passos 2-3): descrição **integral e literal sem corte/resumo**, múltiplas listas nunca se fundem, `fonte_descricao='portal'` detectada por conteúdo (nunca por nome de arquivo), all-or-nothing por documento, e **confere qtd gravada == qtd declarada/numerada** antes de gravar `extraido`.

**O que falta no prompt:** nenhuma regra de **cópia literal de número** (proibir normalizar/calcular), nenhum **grep reverso** do número contra o verbatim, nenhuma **conferência de soma** (qtd × unitário = total), nenhuma instrução de **conferir a lista contra o piso do Effecti** (validador de recall) nem de **revisar o rascunho determinístico** contra o verbatim.

### A.5 Texto-fonte (para o grep reverso)

`documentos.texto` é o conteúdo extraído **verbatim** (camada 1) — migration `20260608130000_documentos.sql` l. 37. Lido paginado pela RPC `ler_documento` (`20260615240000_ler_documento.sql`, janela `[offset, +limite)`, até 200k/página) e pelo Edge `v1-acervo-ler-documento`. **O insumo do grep reverso já existe e é acessível server-side.**

### A.6 Filas e tabelas correlatas

- `documento_itens` (`20260618130000`): **por documento** (dedup global). Tem `lista_origem`, `fonte_descricao ∈ {tecnica,portal}`, `item_numero` (texto livre), `lote`, `descricao`, `unidade`, `quantidade`, `preco_referencia`, `ordem`. **Não tem** coluna de "suspeito/validado".
- `triagem_item_matches` (`20260619180000`): match item×produto, **por aviso** (chave `aviso_id + documento_item_id`), com `score` e `produto_nome` snapshot. Gravado por `v1-triagem-veredito` (delete-then-insert por aviso).
- `triagem_match_feedback` (`20260619200000`): **fila de feedback humano** (padrão SOM, nasce `pendente` → `promovido`/`descartado`). Ações `corrigir`/`remover`/`adicionar`. **Escopo: erro de MATCH (item×produto/SKU), não erro de EXTRAÇÃO.** Por aviso+item.
- `20260618170000_triagem_cleanup_recall_por_item.sql`: removeu a RPC morta `busca_produtos_por_documento` (o servidor não cruza mais edital×catálogo) e promoveu `politica_participacao(nivel,escopo_id)` a UNIQUE. Contexto, sem item-extração direta.

---

## A-bis) Integração Lion ↔ dlh-core (estado atual — JÁ CABEADO)

A ponte entre a Lia (LionClaw) e o dlh-core **já existe e está em produção**, no MCP `acervo-triagem` — código em `C:\Users\Dell\lionclawv1.0\mcp-servers\acervo-triagem\src\index.ts` (501 linhas). É um MCP **fino**: faz `fetch` autenticado nas Edge Functions `/v1` e repassa o JSON. As travas determinísticas ficam **no servidor (dlh-core)**, não no MCP — confirmado abaixo.

### As 4 tools expostas à Lia
| Tool (l.) | Método → Edge | Chave | Papel |
|---|---|---|---|
| `triagem_fila` (l.102) | GET `v1-triagem-fila` (l.48) | `DLH_ACERVO_API_KEY` (read) | Puxa avisos indexados não triados, com `itens_licitacao`, `documentos[].itens_status`, few-shot, regras, objeto `agente` versionado e `conhecimentos`. Paginação de avisos (keyset `cursor`) e **de itens** (`itens_cursor`/`itens_next_cursor`, 35 itens/página). Modos `aviso_id` (envelope de 1 aviso) e `ids_only` (lote p/ triagem paralela). |
| `documento_itens_gravar` (l.341) | POST `v1-documento-itens-gravar` (l.50) | `DLH_TRIAGEM_WRITE_KEY` (write:triagem) | Persiste a(s) lista(s) de itens que a Lia extraiu de UM documento. 1x/doc (dedup global). |
| `triagem_veredito` (l.235) | POST `v1-triagem-veredito` (l.49) | `DLH_TRIAGEM_WRITE_KEY` | Posta rótulo de relevância (alta/média/baixa) + motivo + produto candidato + `itens_matches[]`. O servidor classifica (SOM) e grava o veredito. |
| `politica_participacao` (l.439) | POST `v1-politica-participacao` (l.51) | `DLH_ACERVO_API_KEY` (read) | Consulta a decisão determinística de participação por produto/SKU. |

### As 2 chaves do Vault do Lion
Injetadas pelo `mcp-manager` a partir do Vault do LionClaw (cabeçalho l.38-41):
- **`DLH_ACERVO_API_KEY`** (`lia_sk_…`, read-only) — `triagem_fila` e `politica_participacao`.
- **`DLH_TRIAGEM_WRITE_KEY`** (`lia_tw_…`, escopo `write:triagem`) — `documento_itens_gravar` e `triagem_veredito`.

`callEdge` (l.59-97) faz `Authorization: Bearer <chave>`, timeout 20s, e trata erro HTTP. **Credenciais, escopos e roteamento já estão prontos — nada a criar aqui.**

### MCPs irmãos no fluxo de itens (já existentes)
- `acervo-ler-documento` → tool **`acervo_ler_documento`**: lê o **texto integral (verbatim)** de um documento por id, paginado. O `documento_id` vem direto da fila (`documentos[].documento_id`). **É o insumo da revisão do rascunho e do grep reverso — já disponível à Lia.**
- `acervo-search` → **`acervo_search`** (busca semântica de editais), **`produtos_busca`** (busca semântica do catálogo/SKU), **`selecionar_sku`** (escolha determinística de SKU).
- `substrato-sql` → **`substrato_sql`**: SELECT read-only sobre todo o schema public do dlh-core.

### Fluxo de itens já cabeado
```
triagem_fila (pega aviso + itens_status='pendente')
   → acervo_ler_documento (lê o verbatim do documento)
   → [Lia estrutura os itens]
   → documento_itens_gravar (POST status='extraido' + itens[])
   → produtos_busca / selecionar_sku / politica_participacao (cruza)
   → triagem_veredito (rótulo + itens_matches)
```
Toda a tubulação que o plano precisa **já existe**. As mudanças do plano caem **dentro** dela (Edge + prompt + schema), não na criação de canos.

### Corpo enviado por `documento_itens_gravar` e validação no MCP (confirmado)
Schema zod de **entrada por item** (l.373-385): `lista_origem`, `fonte_descricao` (`'tecnica'|'portal'`), `item_numero`, `lote`, `descricao`, `unidade`, `quantidade`, `preco_referencia`, `ordem`. Topo: `documento_id`, `status` (`extraido|sem_itens|erro|ignorado`), `motivo`. O corpo POST é montado em l.399-401 (só repassa `documento_id`/`status`/`itens`/`motivo`).

**Validação no lado do MCP hoje: NENHUMA além do formato zod** (tipos, enums, tamanhos). Sem grep reverso, sem conferência de soma, sem checagem de recall do Effecti, sem nada de fidelidade. O MCP é pass-through — **as travas têm que viver nas Edges**: fidelidade per-documento em `v1-documento-itens-gravar`, recall do Effecti per-aviso em `v1-triagem-veredito`.

**Lacuna de schema para os campos novos:** o payload atual **NÃO** comporta `item_estado`, `item_origem`, nem "fonte do número". Implicação (detalhada na seção D e no fechamento):
- `item_estado='revisado'` → pode ser definido **server-side** (uma POST da Lia = revisão concluída). **Sem mudança no MCP.**
- `item_origem` (`deterministico`/`llm`/`effecti`) por item → se quisermos a proveniência reportada **pela Lia**, é preciso **um campo opcional novo no zod do MCP (l.373-385) E no zod da Edge**. Mudança pequena, mas existe.
- `piso_effecti[]` → entra na **resposta** de `triagem_fila`. Como o MCP repassa cada aviso inteiro dentro de `itens` (l.212), basta o servidor incluir `piso_effecti` **dentro de cada aviso** → **sem mudança no MCP**. (Só precisaria tocar o MCP se fosse um campo de topo do envelope.)

---

## B) O que já existe (reaproveitável) vs o que falta

### Reaproveitável
- **Schema `documento_itens`** já comporta os campos de item (item_numero texto, quantidade, unidade, preco_referencia, fonte_descricao, lista_origem). Falta só estado de rascunho/revisão/suspeito e marca de origem.
- **Write path idempotente** (`v1-documento-itens-gravar`) com máquina de estados e retorno de ids — é o lugar natural para plugar a **trava de fidelidade per-documento** (o recall do Effecti, per-aviso, fica no `v1-triagem-veredito`).
- **Precedente de recall per-aviso no veredito** (`v1-triagem-veredito`): `temDocExtraivelSemItens(db, effecti_id)` (l.228) já agrega os docs do aviso e rebaixa o veredito (`rebaixado_por_recall`, l.599) — molde pronto para o validador de recall do Effecti.
- **Hook de enriquecimento na ingestão** (`enriquecerItensBestEffort`, "só grava se ainda pendente") — molde pronto para gravar o **rascunho determinístico** (PDF/DOCX) sem sobrescrever item já revisado/decidido.
- **Parser determinístico de PDF já existe e está testado** (`.github/scripts/extrair-itens-pdf.mjs`, por coordenada, com portões de recall). Foi só **desconectado** em `baab507`, não removido → reativar como rascunho é baixo custo.
- **Parser determinístico de DOCX** (`extrair-itens.mjs`) já roda; vira rascunho com a mesma mudança de estado.
- **Verbatim acessível** (`documentos.texto` / `ler_documento`) — insumo do grep reverso, da conferência de soma e da revisão do rascunho pela Lia.
- **Padrão de fila SOM** (`triagem_match_feedback`): modelo de fila pendente→curadoria reutilizável para a triagem de itens suspeitos.
- **`instrucoes_operacionais` cockpit-driven e versionado** — adicionar regras de fidelidade/recall/revisão de rascunho é editar um registro, com bump de versão carimbado no veredito.
- **Lógica de normalização/cruzamento** (`normDesc`, `marcarEffecti` em `automacao-aviso-itens.ts`) — reaproveitável para o **validador de recall** (casar item do Effecti × item da lista extraída por número OU descrição normalizada).

### Falta
1. **Validador de recall do Effecti (per-aviso, no veredito).** Cruzar o piso garantido (`itensEdital`) contra a **união** dos itens dos docs do aviso e **rebaixar o veredito** se algum item do Effecti não aparece. Não existe como tal (a `marcarEffecti` só pinta badge; o `rebaixado_por_recall` cobre "doc sem itens", não "item do piso ausente").
2. **Camada de validação de fidelidade**: grep reverso do número no verbatim + conferência de soma. Não existe em lugar nenhum.
3. **Dois estágios de extração**: hoje o determinístico (DOCX) grava direto `extraido` e o PDF está desligado. Falta o estado intermediário **rascunho/pendente_revisao** e a revisão obrigatória da Lia antes do `extraido` final.
4. **Estado de item** (`rascunho`/`revisado`/`suspeito`) e **marca de origem** (`deterministico`/`llm`/`effecti`) em `documento_itens`. Hoje só há `fonte_descricao ∈ {tecnica,portal}`.
5. **Fila de triagem de extração** (a fila atual é de match, não de extração) + persistência de correção humana fora do `documento_itens` (que é zerado a cada re-extração).
6. **Exposição do `itensEdital` à Lia** no payload da fila (hoje só no cockpit) — agora como **piso de recall a validar**, não como esqueleto.
7. **OCR table-aware + portão de qualidade** para PDF escaneado (hoje só roteia `precisa_ocr` → workflow `extrair-ocr`, sem gate de confiança nem preservação de tabela).

---

## C) Onde encaixar cada peça

### C.0 Mapa: onde cada mudança cai (e o que NÃO muda)

Como a integração já está cabeada (A-bis), cada peça do plano tem um lugar definido:

| Mudança | Onde cai | Toca o MCP? |
|---|---|---|
| Trava de fidelidade (grep reverso + conferência de soma) | **Edge `v1-documento-itens-gravar`** (per-documento) | Não |
| Validador de recall do Effecti (per-aviso) | **Edge `v1-triagem-veredito`** (agrega itens de TODOS os docs do aviso vs `itensEdital`) + `piso_effecti[]` no payload da fila | Não (piso vai dentro de cada aviso) |
| Cópia literal de número, guardrail anti-ancoragem, revisão do rascunho contra o verbatim | **Instruções/prompt da Lia** (`instrucoes_operacionais`) | Não |
| `item_estado='revisado'` ao gravar | **Edge** (deduzido: POST da Lia = revisado) | Não |
| `item_origem` (deterministico/llm/effecti) reportado **pela Lia** | **Edge (zod)** + **MCP (zod l.373-385)** | **Sim — 1 campo opcional** |
| Rascunho determinístico (reativar PDF), `item_estado`, `item_origem`, novos `itens_status` | **Ingestão** (`extrair-anexos.mjs`, `documentos-ingerir`) + **migrations** | Não |
| Fila de triagem de extração + badges | **Migration + nova Edge + cockpit** | Não |

**O que NÃO precisa ser criado (já existe):** o MCP `acervo-triagem` e suas 4 tools; as 2 chaves do Vault e seus escopos; `acervo_ler_documento` (verbatim para revisão/grep); `produtos_busca`/`selecionar_sku`/`politica_participacao` (cruzamento); a paginação de itens com recall; o write path idempotente; o `itensEdital` já capturado em `payload_bruto`. **O MCP quase não muda** — no máximo um campo opcional `item_origem` por item, e só se quisermos a proveniência vinda da Lia (do contrário, zero mudança no MCP).

### C.1 Extração em DOIS ESTÁGIOS (rascunho determinístico → revisão da Lia → trava do servidor)

O verbatim (`documentos.texto`) é **sempre o canônico**. O rascunho determinístico é **hipótese a conferir, nunca fato**. Foi a instabilidade do parser de PDF (descrição infiel em tabela com coluna de código / multi-linha) que motivou o desligamento em `baab507`; por isso o rascunho **não pode ter poder de decisão**.

**Estágio 1 — Rascunho na ingestão (rápido, grátis, sem LLM).**
- Reativar em `.github/scripts/extrair-anexos.mjs` o ramo PDF (re-importar `extrairItensPdfBytes` de `extrair-itens-pdf.mjs`), revertendo parcialmente `baab507`. DOCX continua igual.
- A diferença em relação a hoje: a lista produzida entra com **estado de rascunho**, não `extraido`. Em `documentos-ingerir.persistirItens` (e `enriquecerItensBestEffort`), gravar os itens com `item_estado='rascunho'`, `item_origem='deterministico'` e virar `itens_status='pendente_revisao'` (novo estado), **nunca** `extraido`.
- Motivo de manter o determinístico: em tabela limpa de PDF nativo o parser por coordenada às vezes pega item que a LLM, lendo texto corrido, pula → ganho de recall. O rascunho serve de **checklist** para a Lia.
- ⚠️ **Ganho limitado no caso difícil (B6):** os dois portões do `extrair-itens-pdf.mjs` retornam **`[]`** quando a numeração não é contígua ou a confiança estrutural é baixa (l.165-172) — exatamente a tabela com coluna de código / multi-linha que motivou o `baab507`. Ou seja, o rascunho vem **vazio** justo onde mais se precisaria de checklist; o ganho fica restrito a PDFs de tabela limpa, e **a LLM continua sendo a extratora principal** nos casos difíceis. Avaliar (Sprint 2) afrouxar os portões para "rascunho" (já que ele não decide mais) ou aceitar o ganho restrito.

**Estágio 2 — Revisão da Lia na triagem (contra o verbatim).**
- A fila (`triagem-fila.ts`) entrega à Lia, por documento, o **rascunho** (itens em `rascunho`) + o estado `pendente_revisao` + o piso do Effecti (C.2).
- A Lia lê o **texto verbatim** (`acervo_ler_documento`) — fonte canônica — e: corrige linhas fundidas / coluna trocada / ruído de OCR, **completa** o que o rascunho perdeu, **remove** lixo (linhas que não são item), e confirma número/qtd/unidade por cópia literal.
- Ao postar em `v1-documento-itens-gravar`, os itens vão com `item_estado='revisado'` e `item_origem` apropriado (`deterministico` se confirmou a linha do rascunho, `llm` se a achou/reescreveu, `effecti` se veio do piso).

**Estágio 3 — Trava do servidor (C.2 + C.3) antes de gravar `extraido`.** Só depois das travas passa de `revisado` para o `extraido` final.

**Guardrail anti-ancoragem (crítico):** o `instrucoes_operacionais` deve dizer **explicitamente** que o rascunho é hipótese, não verdade: *"a lista que você recebe é um RASCUNHO automático que pode ter linhas fundidas, colunas trocadas ou itens faltando; trate-a como ponto de partida a conferir contra o TEXTO VERBATIM — corrija e complete livremente, não confie cegamente. O verbatim é a fonte canônica."*

### C.2 Effecti como VALIDADOR DE RECALL (piso garantido, não fonte da lista)

**Mudança de papel:** os itens do Effecti (`itensEdital`) são os que **casaram a palavra-chave do perfil** — ou seja, itens que **sabidamente existem** no edital. São um **PISO GARANTIDO de recall**, não a lista (que é parcial por construção, A.3). A lista final = **itens do Effecti + itens extraídos do edital**; os extras são o **ganho** (o que escapou do keyword do Effecti).

**Regra de ouro:** se faltar algum item na extração, ele **NUNCA** pode ser um item do Effecti. *Item do Effecti ausente da lista extraída = buraco de recall = extração incompleta.*

**ONDE RODA (corrigido — B1): no `v1-triagem-veredito`, per-aviso — NÃO na Edge de gravar.** A Edge `v1-documento-itens-gravar` recebe **só `documento_id`** (corpo l.70-74); o piso é **por aviso** e um item do `itensEdital` pode estar em **outro documento** do mesmo aviso, além de um documento ser compartilhado por N avisos com `itensEdital` diferentes. Validar recall na Edge per-documento geraria `recall_incompleto` **falso** sempre que o aviso tem >1 edital/anexo. O `v1-triagem-veredito` **já é per-aviso** e **já tem o precedente** `temDocExtraivelSemItens(db, effecti_id)` (l.228, agrega todos os docs do aviso por `effecti_id`), chamado no handler (l.495) e refletido em `rebaixado_por_recall` (l.599).

**Encaixe:**
- `triagem-fila.ts`: expor `piso_effecti[]` **dentro de cada aviso** do payload (lido de `avisos.payload_bruto->itensEdital`). Como o MCP repassa cada aviso inteiro (l.212), **não há mudança no MCP** — a Lia recebe o piso direto.
- **Validação no `v1-triagem-veredito`** (per-aviso, agrega itens de TODOS os documentos do aviso): cruzar **todo** item de `itensEdital` contra a união dos `documento_itens` dos docs do aviso, casando por número **OU** similaridade de descrição (porta de `normDesc`), com **limiar tolerante** (decisão 2). Pseudo:
  ```
  itensAviso = união dos documento_itens de todos os docs do aviso (por effecti_id)
  faltantes = [e ∈ itensEdital | nenhum item de itensAviso casa(e) por número OU normDesc(limiar)]
  se faltantes não vazio:
     se aparenta SÓ divergência de redação → enfileira documento_item_suspeitas(tipo='recall_effecti')
        e pede CONFIRMAÇÃO HUMANA (não loop)
     senão → rebaixa o veredito (novo motivo, ex.: rebaixado_por_recall_effecti) e enfileira
  ```
- **Saída garantida (B3):** o recall **não** trava gravação em loop; produz um **rebaixamento do veredito no nível do aviso** (visível, espelhando `rebaixado_por_recall`) + uma linha na fila `documento_item_suspeitas`. Não há estado bloqueante per-documento (ver S1.1 — `recall_incompleto` foi removido do schema).
- A Lia também recebe o piso e é instruída a garantir que todos apareçam antes de postar (defesa em profundidade).

> A decisão E.1 foi fechada: o Effecti **não** expõe a lista completa por API. O `itensEdital` é o piso; se um dia a API expuser a lista completa, fortalece o piso **sem mudar a arquitetura** (validador de completude per-aviso, não fonte da lista).

### C.3 Camada de validação de fidelidade

**Onde roda: trava determinística per-documento no `v1-documento-itens-gravar`, com pré-checagem na Lia (defesa em profundidade).** A trava server-side é a confiável (a Lia pode "esquecer" a instrução; o Edge não). Roda sobre a lista **revisada** (estágio 3). **NÃO inclui o recall do Effecti** (que é per-aviso, C.2/veredito) — só fidelidade per-documento.

**Atomicidade (B2):** a validação é **pura** (sobre o payload + verbatim, sem efeito colateral) e roda **antes de qualquer delete**. Só depois de decidida a lista (com as marcas de suspeito) é que ocorre o delete-then-insert. Assim um eventual aborto nunca deixa o documento vazio. (Itens suspeitos **são inseridos** normalmente, marcados.)

Fluxo no Edge (status `extraido`):
1. **Validar (sem efeito colateral):** carregar o verbatim de `documentos.texto` do `documento_id` (ver B5 sobre tamanho) e rodar grep + soma sobre o payload, anotando suspeitos em memória.
2. **Grep reverso** de cada número (`item_numero`, `quantidade`, `preco_referencia`) contra o verbatim, tolerante a formato pt-BR (porta de `parseNumeroBr`, variantes `1.234,56` / `1234,56` / `1234.56`). Validar **tupla** (número junto da unidade/contexto), não inteiro solto:
   ```
   para cada numero n do item:
     se não existe ocorrência literal de alguma_variante(n) no verbatim → item.suspeito=true, motivo += "numero <n> ausente no texto-fonte"
   ```
3. **Conferência de soma**: se o item traz qtd, preço unitário e total, checar `|quantidade*preco_referencia - total| <= epsilon`; divergiu → suspeito.
4. **Aceite parcial (decisão 4):** gravar `extraido` com **todos** os itens — válidos e suspeitos (recall total — nunca dropar) —, marcando `item_estado='suspeito'` nos reprovados e enfileirando-os em `documento_item_suspeitas(tipo='fidelidade')`. O documento permanece `extraido` (suspeito de fidelidade **não** trava). Só agora roda o delete-then-insert.

**Roteamento do item reprovado:** novo registro na fila de extração (ver D — tabela `documento_item_suspeitas`). Reusa o **padrão** de `triagem_match_feedback` (pendente → humano confirma/corrige → aprendizado), em tabela separada (escopo extração, não match). **Importante:** correções humanas **não** podem morar em `documento_itens` (zerada a cada re-extração delete-then-insert) — devem viver na fila, chaveadas por aviso+item / conteúdo.

**Cuidado de fidelidade do próprio grep:** números pequenos (`item 1`, `qtd 2`) casam trivialmente no verbatim e dão **falso "ok"**. Mitigação: confiar no grep reverso sobretudo para **preços e quantidades grandes**; para inteiros pequenos, validar a **tupla** (qtd+unidade adjacentes, ou número junto da unidade) em vez do número solto.

### C.4 Tratamento de OCR

- **Hoje:** PDF imagem → `precisa_ocr` (migration `20260615330000`) → workflow `extrair-ocr.yml` → texto Tika/OCR em `documentos.texto`. Sem gate de qualidade.
- **Proposta:** (1) **OCR table-aware/layout-preserving** para não achatar a tabela (a perda de coluna é a raiz do problema de descrição infiel). (2) **Portão de qualidade**: estimar confiança do OCR (densidade de caracteres válidos, taxa de tokens dicionarizados, confiança do motor se disponível). Abaixo do limiar → marcar o documento como OCR-baixa-confiança e **rotear ao humano**; a Lia não deve gravar números desse documento sem flag. Nessa condição o grep reverso passa a ser fraco (o número pode existir, porém corrompido) — por isso o gate de qualidade precede a confiança no grep.

---

## D) Mudanças necessárias (agrupadas, com esforço e risco)

Esforço: **P** ≤ ~0,5 dia · **M** ~1-2 dias · **G** ≥ 3 dias. Risco considera regressão de recall e de comportamento da Lia.

> **Nada de integração/credencial/MCP a criar** (A-bis): o MCP `acervo-triagem`, as 4 tools, as 2 chaves do Vault e o fluxo de itens já rodam. O trabalho abaixo é incremento sobre a tubulação existente.

### Migrations (schema)
| Mudança | Esforço | Risco |
|---|---|---|
| `documento_itens`: add `item_estado text default 'rascunho' check in ('rascunho','revisado','suspeito')` + `item_origem text check in ('deterministico','llm','effecti')` + `suspeito_motivo text` (+ índice parcial). Aditivo/idempotente. | P | Baixo |
| `documentos.itens_status`: estender o check para incluir `pendente_revisao` (rascunho de PDF aguardando a Lia — usado na Sprint 2). **Sem `recall_incompleto`** (o recall é per-aviso no veredito, não um estado per-documento — B1/B3). | P | Médio (toca CHECK existente; cuidar idempotência) |
| Nova tabela `documento_item_suspeitas` (fila de extração, padrão `triagem_match_feedback`: pendente→confirmado/corrigido, snapshot da descrição/número, autor, motivo, tipo ∈ {fidelidade, recall_effecti}). Chave por aviso+item / conteúdo. | M | Baixo-Médio |
| (OCR) flag de qualidade em `documentos` (ex.: `ocr_confianca numeric` / `ocr_baixa_confianca boolean`) + estado/filtro. | P-M | Médio |
| Update do singleton `triagem_agente_config.instrucoes_operacionais` (revisão de rascunho + cópia literal + recall do Effecti) + bump de `versao`. | P | **Médio** (prompt = comportamento; precisa eval) |

### Edge Functions / Scripts de ingestão
| Mudança | Esforço | Risco |
|---|---|---|
| **Reativar o parser de PDF** em `extrair-anexos.mjs` (re-importar `extrairItensPdfBytes`, reverter parcialmente `baab507`) — mas a saída entra como **rascunho**, não `extraido`. | P | Médio (foi desligado por instabilidade; mitigado por nunca decidir) |
| `documentos-ingerir` (`persistirItens`/`enriquecerItensBestEffort`): gravar rascunho com `item_estado='rascunho'`, `item_origem='deterministico'`, `itens_status='pendente_revisao'` (nunca `extraido`). | P-M | Médio |
| `v1-documento-itens-gravar` (**per-documento**): validar **antes do delete** (B2), grep reverso (variantes pt-BR, tupla número+contexto), conferência de soma, marcar `item_estado='suspeito'` (aceite parcial), gravar `item_estado='revisado'`/`item_origem`, enfileirar suspeitos de fidelidade. **Sem recall do Effecti aqui.** | M-G | **Alto** (hot path; atomicidade + verbatim grande B5) |
| `v1-triagem-veredito` (**per-aviso**): validador de recall do Effecti — agregar itens de todos os docs do aviso (por `effecti_id`, como `temDocExtraivelSemItens` l.228) e cruzar com `itensEdital`; faltante → rebaixar veredito + enfileirar `documento_item_suspeitas(tipo='recall_effecti')`. Reusa o padrão `rebaixado_por_recall` (l.599). | M | Médio |
| **Porte cross-runtime (B4):** extrair `parseNumeroBr` (de `extrair-itens.mjs` Node, l.50) e `normDesc` (de `automacao-aviso-itens` Edge, l.163) para `supabase/functions/_shared/` (Deno) — não são importáveis hoje. Pré-requisito de S1.2-A/B. | P | Baixo |
| `triagem-fila.ts`: expor `piso_effecti[]` (de `payload_bruto->itensEdital`) e o rascunho/itens em `pendente_revisao` no payload do aviso. | P-M | Baixo |
| `automacao-aviso-itens.ts` (+ leitura da fila): devolver `item_estado`/`item_origem`/`suspeito_motivo` e o sinal de recall do Effecti (rebaixamento per-aviso) para o cockpit. | P | Baixo |
| Novo Edge de fila de extração (GET fila + POST confirmar/corrigir), espelhando `v1-triagem-match-feedback`. | M | Baixo-Médio |
| (OCR) ajustar workflow `extrair-ocr` + `extrator.mjs` para OCR table-aware e cálculo de confiança. | G | Médio-Alto |

### MCP `acervo-triagem` (lionclawv1.0) — quase nada
| Mudança | Esforço | Risco |
|---|---|---|
| **Opcional**: add campo `item_origem` (`deterministico`/`llm`/`effecti`) ao zod por item (l.373-385) **só se** quisermos a proveniência reportada pela Lia. Senão, **zero mudança**. | P | Baixo |
| `piso_effecti` e `item_estado`: **nenhuma** mudança (piso vai dentro do aviso já repassado; estado é server-side). | — | — |
| Mudança | Esforço | Risco |
|---|---|---|
| **Guardrail anti-ancoragem**: tratar o rascunho como hipótese a conferir contra o verbatim ("corrija e complete livremente, não confie cegamente"). | P | **Médio-Alto** (eval; é a regra que evita repetir o problema do `baab507`) |
| Regra de **cópia literal de número** (proibido normalizar/calcular/inferir). | P | Médio (eval) |
| **Recall do Effecti**: garantir que todo item do `piso_effecti` apareça na lista antes de postar. | P | Médio |
| Auto-checagem (grep reverso mental + soma) antes de gravar; na dúvida marca suspeito em vez de inventar. | P | Médio |
| (Opcional) **dupla extração com diff** — segunda passada e comparação; divergência → suspeito. | M | Médio (custo de tokens) |

### Cockpit
| Mudança | Esforço | Risco |
|---|---|---|
| Badges `rascunho`/`revisado`/`suspeito` + origem (determinístico/LLM/Effecti) + motivo na tabela de itens; sinal de recall do Effecti (rebaixamento per-aviso); tela/fila de triagem de extração; ação confirmar/corrigir alimentando a fila. Avaliar impacto no **Design Lock** (`docs/.../design/manifest.json`, `locked:true`). | M-G | Médio (Design Lock pode exigir revisão do lock) |

---

## E) Riscos, casos de borda e decisões que exigem o Fábio

### Decisões (FECHADAS pelo Fábio em 2026-06-20)
1. **✅ DECIDIDO — Fonte da lista vs piso do Effecti.** O Effecti **NÃO** expõe a lista completa por API: só a lista filtrada pelo perfil de palavra-chave (`itensEdital`); a lista completa existe apenas na **tela web** do Effecti. Decisão: o **piso de recall é o subconjunto filtrado (`itensEdital`)**; a lista completa do edital continua vindo da **extração do PDF pela Lia**. **NÃO raspar a tela web** (fragilidade × ganho não compensa; mantém o padrão API-first). Se um dia a API expuser a lista completa, fortalece o piso **sem mudar a arquitetura**.
2. **✅ DECIDIDO — Recall incompleto bloqueia, com tolerância.** Faltar item do piso **bloqueia** (transitório/reprocessável), **mas** com casamento **tolerante** (número **+** similaridade de descrição com limiar). Se persistir divergência **só de redação**, **pedir confirmação humana** em vez de loop de re-extração. *(Realização pós-auditoria B1: o bloqueio é aplicado **per-aviso no `triagem_veredito`** — rebaixamento do veredito + fila — e **não** como estado `recall_incompleto` per-documento, que geraria falso-positivo quando o aviso tem >1 edital. O efeito "não favoritar/avançar um aviso com piso furado" é preservado.)*
3. **✅ DECIDIDO — Trava de fidelidade em AMBOS.** Servidor (Edge, porta determinística) **+** instrução na Lia (defesa em profundidade).
4. **✅ DECIDIDO — Suspeito grava marcado.** Item suspeito (fidelidade) é gravado `extraido` **com marca** (recall total — nunca dropar) e vai para a **fila de revisão de extração**. Distinto do **recall do Effecti** (per-aviso, no veredito), que rebaixa o veredito do aviso em vez de marcar item.
5. **✅ DECIDIDO — Dois estágios SÓ para PDF.** O rascunho determinístico (`pendente_revisao`) vale **só para PDF**. **DOCX continua extraindo direto como `extraido`** (é estável; não passa por revisão).
6. **✅ DECIDIDO — Tabela nova.** Fila de extração em tabela **nova `documento_item_suspeitas`**, separada de `triagem_match_feedback`.
7. **✅ DECIDIDO — OCR mínimo primeiro.** Começar **só com portão de qualidade + roteamento humano**; **OCR table-aware fica para depois**, condicionado a o volume de editais escaneados justificar.

### Casos de borda
- **Rascunho determinístico errado (linha fundida / coluna trocada / ruído):** a Lia deve corrigir contra o verbatim — é o motivo do guardrail anti-ancoragem. Risco: a Lia "confiar" no rascunho e propagar o erro (foi o que derrubou o parser em `baab507`). Mitigação: instrução explícita + a trava de fidelidade pega o número que não bate.
- **Item do Effecti que não casa na lista extraída por diferença de redação:** o item existe no edital, mas a `normDesc`/número não bate (portal abrevia, TR descreve longo). Mitigação: o recall roda no **veredito per-aviso** (não na gravação per-documento, B1) e cruza por número **e** por similaridade de descrição com limiar tolerante; em última instância, **rebaixa o veredito + pede confirmação humana** em vez de travar em loop (decisão 2). Nunca há `recall_incompleto` per-documento.
- **Re-extração não pode apagar correção humana:** `documento_itens` é delete-then-insert a cada run → o `item_estado='revisado'`/correção se perde. **Correções humanas vivem na fila** (`documento_item_suspeitas`), chaveadas por aviso+item/conteúdo, e são **reaplicadas** após cada re-extração. Re-extração só deve rebaixar para `pendente_revisao` o que ainda não foi revisado.
- **Lista no corpo + no TR (múltiplas listas):** já modelado por `lista_origem` (nunca fundir). O grep reverso e o piso do Effecti buscam no verbatim **certo** — listas podem estar em documentos diferentes; validar contra o `documento_id` do item, não um agregado. O piso do Effecti é por **aviso** e pode casar itens de qualquer documento do aviso.
- **Número pequeno casa em qualquer lugar** (`item 1`, `qtd 2`): grep reverso forte para preço/quantidade grande, fraco para inteiro pequeno → validar tupla (número junto da unidade), não bloquear por inteiro trivial.
- **Item de portal sem correspondência no TR:** mantém descrição do portal, `fonte_descricao='portal'`, `item_origem='effecti'`, **não** marcar suspeito (é esperado). Mas conta para o piso de recall (apareceu).
- **Preço por extenso** ("dez mil reais"): não casa o numérico → falso suspeito. Tolerar (suspeito ≠ erro) ou estender o matcher por extenso.
- **OCR ilegível:** número corrompido pode "existir" no texto e passar o grep, ou falhar de vez. Portão de qualidade precede o grep; abaixo do limiar → humano.
- **Recall-total:** item suspeito **nunca** é descartado silenciosamente — fica visível, marcado e triável. Coerente com o código atual (paginação anti-truncamento, all-or-nothing).
- **Design Lock:** novas telas/badges de cockpit exigem revisar `manifest.json` (`locked:true`) antes de implementar (CLAUDE.md).

---

## Sugestão de fatiamento em sprints

> Ponto de partida: a integração Lion ↔ dlh-core já roda (A-bis). **Nenhuma sprint cria integração, credencial ou MCP.** Todo o trabalho é Edge + ingestão + prompt + schema + cockpit, sobre a tubulação existente. O MCP só é tocado (1 campo opcional `item_origem`) se a decisão de proveniência por item exigir.

1. **Sprint 1 — Fundação de fidelidade + recall (servidor).** Migrations de estado (`item_estado`/`item_origem`/`suspeito_motivo`, `documento_item_suspeitas`, `pendente_revisao`; **sem `recall_incompleto`**). Porte de `parseNumeroBr`/`normDesc` para `_shared` (B4). **Fidelidade** (grep + soma, aceite parcial, `item_estado` server-side) no `v1-documento-itens-gravar` per-documento, **validando antes do delete** (atomicidade B2). **Recall do Effecti** no `v1-triagem-veredito` per-aviso (agrega docs por `effecti_id`, rebaixa veredito + enfileira; **sem estado bloqueante**, B1/B3). Expor `piso_effecti[]` dentro de cada aviso na fila (sem tocar o MCP). *(Decisões 1-4. Se `item_origem` vindo da Lia → +1 campo no zod do MCP e da Edge.)*
2. **Sprint 2 — Dois estágios (rascunho) + prompt.** Reativar parser de PDF como rascunho (`pendente_revisao`); ajustar `documentos-ingerir`; reescrever `instrucoes_operacionais` (guardrail anti-ancoragem + cópia literal + recall do Effecti + revisão do rascunho contra o verbatim lido via `acervo_ler_documento`) + eval. *(Decisão 5.)*
3. **Sprint 3 — Fila de triagem de extração + cockpit.** Tabela/Edge `documento_item_suspeitas` (com reaplicação de correção pós re-extração) + badges/telas (revisão do Design Lock). *(Decisão 6.)*
4. **Sprint 4 — OCR.** Portão de qualidade primeiro; OCR table-aware conforme decisão 7.

---

# Apêndice — Detalhamento de execução da SPRINT 1 (Fundação de fidelidade + recall no servidor)

> Pronto para um implementador (Lia / Claude Code) seguir. Tudo server-side + 1 ajuste de fila. **Não toca o MCP** (decisões 1-4). Convenção do projeto: migrations **aditivas e idempotentes**, aplicadas via node pg direto (SUPABASE_DB_URL session pooler), **nunca** `supabase db push`.

## S1.1 — Migrations (schema)

**Arquivo sugerido:** `supabase/migrations/20260620120000_documento_itens_fidelidade.sql` (timestamp > último existente `20260619200000`; ajustar se houver migration intermediária).

Conteúdo (aditivo/idempotente):

1. **`documento_itens`** — três colunas novas:
   ```sql
   alter table public.documento_itens
     add column if not exists item_estado text not null default 'revisado'
       check (item_estado in ('rascunho','revisado','suspeito'));
   alter table public.documento_itens
     add column if not exists item_origem text
       check (item_origem in ('deterministico','llm','effecti'));
   alter table public.documento_itens
     add column if not exists suspeito_motivo text;
   create index if not exists documento_itens_estado_idx
     on public.documento_itens (item_estado)
     where item_estado in ('rascunho','suspeito');
   ```
   - `default 'revisado'` para não quebrar linhas atuais (a extração da Lia já é revisada). O rascunho determinístico (Sprint 2) grava explicitamente `'rascunho'`.
   - `item_origem` nullable (linhas legadas ficam null; sem CHECK forçado de NOT NULL).

2. **`documentos.itens_status`** — estender o CHECK para `pendente_revisao` (só **isto**; **sem `recall_incompleto`** — B1/B3: o recall é per-aviso no veredito, não um estado bloqueante per-documento). O CHECK atual (`20260618130000_documento_itens.sql` l.78-81) é `in ('pendente','extraido','sem_itens','erro','inobtenivel','ignorado')`. Como CHECK não é alterável por "if not exists", **drop + add idempotente**:
   ```sql
   alter table public.documentos drop constraint if exists documentos_itens_status_check;
   alter table public.documentos
     add constraint documentos_itens_status_check
     check (itens_status in
       ('pendente','pendente_revisao','extraido','sem_itens',
        'erro','inobtenivel','ignorado'));
   ```
   > ⚠️ Confirmar o **nome real** da constraint no banco (`\d public.documentos` / `pg_constraint`; é inline sem nome, autogerado provável `documentos_itens_status_check`); ajustar o `drop` ao nome efetivo. **`pendente_revisao` é valor reservado para a Sprint 2** (rascunho de PDF) — **nenhum documento recebe esse status na Sprint 1**, então não introduz estado bloqueante sem caminho de saída (B3). Pode-se adiar a adição dele para a Sprint 2 se preferir migration mínima.

3. **Fila de revisão de extração** — tabela nova (decisão 6). Pode ficar na **mesma** migration ou numa irmã `20260620120100_documento_item_suspeitas.sql`:
   ```sql
   create table if not exists public.documento_item_suspeitas (
     id                uuid primary key default gen_random_uuid(),
     aviso_id          uuid not null references public.avisos(id) on delete cascade,
     documento_item_id uuid references public.documento_itens(id) on delete set null,
     tipo              text not null check (tipo in ('fidelidade','recall_effecti')),
     item_descricao    text,          -- snapshot (sobrevive à re-extração)
     numero_suspeito   text,          -- o número que não bateu (fidelidade)
     motivo            text not null,
     status            text not null default 'pendente'
                       check (status in ('pendente','confirmado','corrigido','descartado')),
     autor             text,
     created_at        timestamptz not null default now(),
     curado_em         timestamptz
   );
   alter table public.documento_item_suspeitas enable row level security;
   create index if not exists documento_item_suspeitas_status_idx
     on public.documento_item_suspeitas (status, created_at desc);
   create index if not exists documento_item_suspeitas_aviso_idx
     on public.documento_item_suspeitas (aviso_id);
   ```
   - `documento_item_id` é `set null` (correção sobrevive ao delete-then-insert da re-extração; o re-vínculo se dá pelo snapshot `item_descricao`/`numero_suspeito`). RLS habilitada, sem policy anon/auth (service_role bypassa), espelhando `triagem_item_matches`/`triagem_match_feedback`.

> **DOCX não é afetado** (decisão 5): `documentos-ingerir.persistirItens` continua gravando `extraido`; com o novo default `item_estado='revisado'` as linhas DOCX ficam coerentes sem mudança nessa Sprint.

## S1.2-A — Fidelidade na Edge `v1-documento-itens-gravar/index.ts` (per-documento)

**Só fidelidade aqui** (grep + soma). O recall do Effecti **não** entra nesta Edge (B1) — ver S1.2-B. A Edge recebe só `documento_id` (corpo l.70-74), então não tem o aviso nem os outros documentos.

**Atomicidade (B2) — requisito explícito:** o `v1-documento-itens-gravar` hoje faz `delete` (l.146-152) → `insert` (l.173) em requests Supabase **separados, sem transação**. Aplicar a trava "antes do insert" mas **depois do delete** arriscaria apagar os itens bons e abortar (documento vazio). **Regra:** a validação é **pura** (payload + verbatim, sem efeito colateral) e roda **ANTES de qualquer delete**. Só após decidir a lista final (com marcas de suspeito, que continuam sendo inseridas) é que ocorre `delete → insert → update`. Alternativa robusta: encapsular `delete+insert+update` numa **RPC/transação** Postgres (`SECURITY DEFINER`, service_role) e chamar de dentro do Edge.

Pontos de inserção citando o código atual:

1. **Carregar o verbatim do documento (validação pura, antes do delete).** Hoje a checagem de existência (l.112-116) faz `select("id, itens_tentativas")`. **Ampliar** para `select("id, itens_tentativas, texto")` — `documentos.texto` é o verbatim canônico (camada 1).
   > ⚠️ **Performance (B5):** `documentos.texto` chega a ~4,4M chars (comentário em `ler_documento`). Puxar o texto inteiro no hot path da gravação custa latência/memória. Estratégia: validar **só os números necessários** (montar o conjunto de tuplas dos itens e buscar cada um), ou ler janelas via `ler_documento`/`substr`, ou um índice de busca — **não** assumir o carregamento integral sem ressalva.

2. **Grep reverso (fidelidade).** Validação em memória sobre o payload + verbatim. Validar **tupla** (número junto da unidade/contexto), não inteiro solto:
   ```
   função numeroPresente(verbatim, n):
     gerar variantes pt-BR de n (1.234,56 / 1234,56 / 1234.56 / inteiro)
     retornar true se ALGUMA variante ocorre literalmente no verbatim
   para cada item:
     suspeito=false; motivos=[]
     se item.preco_referencia e !numeroPresente(verbatim, preco): suspeito; motivos+="preco ausente"
     se item.quantidade>=N_MIN e !numeroPresente(verbatim, qtd): suspeito; motivos+="qtd ausente"
     se item.quantidade<N_MIN: validar "qtd + unidade" adjacentes no verbatim; senão não bloquear por número trivial
   ```

3. **Conferência de soma.** Quando o item traz **quantidade, preço unitário e total**: checar `|quantidade*preco_referencia - total| <= epsilon` (epsilon p/ arredondamento). Divergiu → `suspeito`, motivo `"soma diverge"`.

4. **Porte cross-runtime (B4) — `parseNumeroBr` e `normDesc` NÃO são importáveis.** `parseNumeroBr` vive em **script Node** `.github/scripts/extrair-itens.mjs` l.50 (parser **DOCX**); `normDesc` vive **dentro** da Edge `automacao-aviso-itens/index.ts` l.163. A Edge `v1-documento-itens-gravar` é **Deno** → não importa `.mjs` de Actions nem o interno de outra Edge. **Extrair ambos para `supabase/functions/_shared/`** (ex.: `_shared/numero-br.ts`, `_shared/normalizar.ts`) e importar nas duas pontas. Some ~0,5 dia ao esforço. (Nota: `normDesc` l.163-170 também remove espaços e todo não-alfanumérico, não só pontuação — ao portar, manter o comportamento.)

5. **`item_estado` server-side (decisão 3/4).** No map de `rows` (l.161-172), acrescentar `item_estado: it.suspeito ? 'suspeito' : 'revisado'`, `item_origem: it.item_origem ?? null`, `suspeito_motivo: it.motivos?.join('; ') ?? null`. A Lia **não** envia `item_estado` (deduzido — uma POST da Lia = revisado). `item_origem` só se a Lia reportar (campo opcional no zod do MCP e da Edge; senão null nesta Sprint).

6. **Aceite parcial (decisão 4).** Gravar `extraido` com **todos** os itens — válidos e suspeitos (recall total — nunca dropar). Para cada suspeito, inserir linha em `documento_item_suspeitas(tipo='fidelidade', numero_suspeito, item_descricao, motivo)`. O `update` de status (l.184-190) permanece `extraido` (suspeito de fidelidade **não** rebaixa o documento).

7. **Idempotência + reconciliação da fila.** O delete-then-insert por `documento_id` (l.146-152) continua; re-validar a cada run é ok. Garantir que `documento_item_suspeitas` seja **reconciliada** (não duplicar linha pendente para o mesmo snapshot número/descrição).

## S1.2-B — Recall do Effecti no `v1-triagem-veredito/index.ts` (per-aviso)

**Aqui mora o recall** (B1). O veredito é per-aviso e **já agrega os documentos do aviso** por `effecti_id` — o precedente é `temDocExtraivelSemItens(db, effecti_id)` (l.228), chamado no handler (l.495), refletido em `rebaixado_por_recall` (l.599). O validador de recall do Effecti é simétrico:

```
itensAviso = união dos documento_itens de TODOS os docs do aviso (por effecti_id)   // já há o padrão de agregação
itensEdital = avisos.payload_bruto->itensEdital
faltantes = [e ∈ itensEdital | nenhum item de itensAviso casa(e) por número OU normDesc(limiar tolerante)]
se faltantes não vazio:
   enfileirar documento_item_suspeitas(tipo='recall_effecti', motivo, snapshot)
   rebaixar o veredito no nível do AVISO (novo flag, ex.: rebaixado_por_recall_effecti) — pedir confirmação humana
```

- **Sem estado bloqueante per-documento (B3):** o resultado é um **rebaixamento do veredito** (visível, reprocessável, espelhando o mecanismo existente) + linha na fila — **não** um `recall_incompleto` que prende o documento. Caminho de saída existe na própria Sprint 1.
- **Casamento tolerante (decisão 2):** número **OU** similaridade de descrição com limiar; divergência só de redação → confirmação humana, nunca loop.
- Reusa a porta `normDesc` extraída para `_shared/` (S1.2-A passo 4).

## S1.3 — Expor `piso_effecti[]` na fila (`_shared/triagem-fila.ts`) — sem tocar o MCP

1. **Select dos avisos:** os `selectCols` (l.591-593, 613-615, 741-743) hoje puxam só `uf` do `payload_bruto` via arrow. **Acrescentar** `"piso_effecti:payload_bruto->itensEdital"` ao `selectCols` (sub-campo limitado, **não** o `payload_bruto` inteiro — respeita SEC-4/RNF-01, l.31).
2. **`interface AvisoRow`** (l.262+): adicionar `piso_effecti?: unknown`.
3. **`interface TriagemFilaItem`** (l.~176-182) e a montagem do envelope (l.438-451): adicionar `piso_effecti: Array.isArray(aviso.piso_effecti) ? aviso.piso_effecti : []`.
4. **MCP intocado:** `triagem_fila` repassa cada aviso inteiro dentro de `itens` (`acervo-triagem/src/index.ts` l.212) → o `piso_effecti` chega à Lia **sem** mudança no MCP.

## S1.4 — Instrução na Lia (defesa em profundidade, decisão 3)

Pequeno acréscimo ao `instrucoes_operacionais` (singleton; **R10**: editar o `.ts`/seed correspondente **e** migration SQL de UPDATE + bump de `versao`). Texto: cópia literal de número (proibido normalizar/calcular); garantir que todo item do `piso_effecti` apareça antes de postar; na dúvida marcar suspeito em vez de inventar. (O grosso do prompt — guardrail anti-ancoragem/revisão do rascunho — é da Sprint 2; aqui só a parte que casa com a trava do servidor.)

## S1.5 — Critérios de aceite

- Migration roda 2× sem erro (idempotência) e sem perder dados; `item_estado` default `revisado`; `pendente_revisao` aceito; **`recall_incompleto` não existe** no schema.
- **Atomicidade (B2):** sob qualquer bloqueio/erro de validação, o documento **nunca** fica vazio — a validação é pura e roda antes do delete (ou tudo numa transação/RPC). Teste: forçar falha após a validação e confirmar que os itens anteriores permanecem intactos.
- POST `extraido` com número inexistente no verbatim → item gravado com `item_estado='suspeito'` + linha em `documento_item_suspeitas(tipo='fidelidade')`; documento permanece `extraido` (**fidelidade não trava**).
- POST `extraido` com números conferidos → grava `extraido`, todos `item_estado='revisado'`, zero suspeitas.
- **Recall (per-aviso, no veredito):** aviso cujo `itensEdital` tem item ausente da união dos `documento_itens` dos seus docs → `triagem_veredito` **rebaixa o veredito** (não trava gravação) + linha `documento_item_suspeitas(tipo='recall_effecti')`. Aviso com >1 edital **não** gera falso-positivo (validação agrega todos os docs).
- DOCX (caminho `documentos-ingerir`) continua gravando `extraido` sem regressão.
- `triagem_fila` retorna `piso_effecti` dentro de cada aviso; MCP inalterado; payload da fila **não** vaza `payload_bruto` inteiro.

## S1.6 — Casos de teste (inclui bordas)

| # | Cenário | Esperado |
|---|---|---|
| T1 | Número grande (preço 12.345,67) ausente do verbatim | `suspeito` + fila fidelidade |
| T2 | **Número pequeno** (`item 1`, `qtd 2`) ausente como inteiro solto | **Não** marca suspeito por inteiro trivial; valida tupla qtd+unidade |
| T3 | **Preço por extenso** ("dez mil reais"), sem numérico no texto | Tolerar: `suspeito` (≠ erro) ou ignorar conforme heurística; **nunca** bloqueia o documento |
| T4 | **Item de portal sem TR** (só no `itensEdital`) | Conta para o piso (apareceu), `fonte_descricao='portal'`, **não** suspeito |
| T5 | **Redação divergente** (item do piso existe, `normDesc` não casa por número) — no **veredito** | Casamento tolerante por similaridade; se persistir → `recall_effecti` + **confirmação humana**, não loop |
| T6 | Soma: qtd×unit ≠ total declarado | `suspeito` motivo "soma diverge" |
| T7 | Item do piso realmente ausente (buraco real) — no **veredito per-aviso** | `triagem_veredito` **rebaixa o veredito** + enfileira `recall_effecti`; **não** há `recall_incompleto` per-documento |
| T7b | **Aviso com >1 edital**, item do piso está no documento B mas não no A | **Sem** falso-positivo: o veredito agrega itens de A+B antes de validar (B1) |
| T8 | Re-extração do mesmo documento | Re-valida; **não** duplica linha pendente em `documento_item_suspeitas`; correção humana anterior preservada |
| T9 | Lista no corpo + no TR (multi-lista) | grep no verbatim **do documento certo**; piso casa item de qualquer documento do aviso |
| T10 | DOCX estável | grava `extraido` direto, sem `pendente_revisao` (decisão 5) |
| T11 | **Atomicidade (B2):** falha forçada após a validação, antes do insert | Itens anteriores **intactos**; documento nunca fica vazio |
