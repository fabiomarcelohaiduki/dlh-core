# SPEC - Fonte Nomus (ERP) / Ingestao de Processos
> Gerado automaticamente pelos pipelines do LionClaw. Fonte de verdade para implementacao.
> Projeto: DLH Core (substrato de memoria operacional + cockpit de ingestao).
> Feature: adicionar o ERP Nomus como segunda fonte de dados, comecando pela ingestao dos Processos do tipo "Venda Governamental" das empresas famaha e darlu.
> Base: PRD20260606_193657.md + stories-requisitos20260606_193657.md (ambos aprovados).

---

## 1. Resumo do Produto

### 1.1 Problema, publico-alvo e pitch (copiado do PRD)
- **Problema:** o cerebro do DLH nao tem memoria operacional interna. O Effecti traz editais externos (oportunidades de fora); falta o estado interno do ERP (vendas governamentais em andamento). Um processo Nomus do tipo "Venda Governamental" e a continuacao do ciclo de vida de um aviso aprovado (o aviso vem do Effecti, passa por aprovacao humana e e cadastrado no Nomus). Ingerir esses processos enriquece o substrato com o estado operacional real e habilita a Lia a recuperar memoria por similaridade textual.
- **Publico-alvo:**
  - **Operador do cockpit:** usuario interno autorizado do nucleo DLH (perfil unico `interno`, login via Google OAuth). Configura fontes, dispara coletas, monitora a saude da ingestao.
  - **Lia (IA consumidora):** consumidora read-only do substrato via API `/v1`, recupera memoria operacional por significado.
- **Pitch:** adicionar o Nomus como fonte multi-recurso de dados internos reaproveitando o PADRAO arquitetural existente (paginacao, backoff, sync incremental, dedup, indexacao por embeddings, observabilidade), com contrato de dados e persistencia proprios do dominio de processos. O Effecti permanece intacto. Escopo desta entrega: apenas `/processos` filtrando `tipo = "Venda Governamental"`, ja desenhado para acomodar recursos/tipos futuros por toggle, sem reescrita.

### 1.2 Stack escolhida (copiada do PRD)
- **Linguagem:** TypeScript ponta a ponta.
- **Frontend:** Next.js 15.5 (App Router) + React 19, Tailwind CSS 3.4 + shadcn/ui, Lucide, TanStack Query 5, react-hook-form + zod, `@supabase/ssr`. Deploy alvo Vercel.
- **Backend:** Supabase Edge Functions (Deno/TypeScript) em `supabase/functions`.
- **Substrato:** Supabase / PostgreSQL + pgvector + Auth + Storage + Edge Functions + pg_cron + Realtime + Vault.
- **Autenticacao:** Supabase Auth, login exclusivamente via Google (OAuth). Perfil unico no MVP (`interno`).
- **Embeddings:** provider plugavel, padrao bge-m3 self-hosted, `vector(1024)`, indice HNSW (`vector_cosine_ops`).

### 1.3 Plataforma
- Web (cockpit interno) + API `/v1` para a Lia. Sem mobile/desktop nesta entrega.

### 1.4 Decisoes de design tomadas nesta SPEC (resolvem lacunas L-03 e tratam L-01/L-05)
> A SPEC e a fase de design. As lacunas abaixo sao decididas aqui, com sinalizacao explicita conforme exige o PRD.
- **DD-01 (L-03 - modelo de chunks agnostico):** decidido **criar a NOVA tabela `memoria_chunks` que COEXISTE com `aviso_chunks`** (que permanece INTACTA), em vez de alterar a tabela viva. Os chunks de processo sao gravados em `memoria_chunks` com `origem`, `tipo` e `registro_id`; `aviso_chunks` segue servindo a busca de avisos sem qualquer alteracao de schema nem migracao. Motivo: risco ZERO de regressao na busca de avisos em producao (a tabela em uso nao e tocada) e alinhamento com a decisao aprovada do PRD (D-02/B-03). A unificacao/migracao dos chunks de avisos para `memoria_chunks` fica para entrega posterior. Sinalizado como decisao de design.
- **DD-02 (L-01 - campo de ultima alteracao da API Nomus):** a SPEC contempla os DOIS caminhos do PRD (RF-22/RF-23). Caminho primario: filtro `?query=campoData>yyyy-mm-ddTHH:mm:ss` sobre data de alteracao. Caminho de fallback: re-scan periodico de processos com `etapa` nao terminal (etapas terminais definidas em `config_ingestao.recursos.<recurso>.etapas_terminais`; valores reais a confirmar apos amostra da API - L-01). A escolha em runtime e governada por flag em `config_ingestao.recursos` (`usa_filtro_data_alteracao`), default `false` ate confirmacao com o usuario (L-01 permanece como dependencia externa a confirmar, mas o codigo acomoda ambos).
- **DD-03 (L-05 - contrato da Lia):** a generalizacao da RPC `busca_semantica_chunks` e estritamente ADITIVA: os campos hoje retornados (`aviso_id`, `verbatim`, `similaridade`) sao PRESERVADOS; sao adicionados `origem` e `registro_id`. O join passa a ser origem-aware (union entre `aviso_chunks` e `memoria_chunks` conforme o escopo). Confirmacao do contrato exato com o usuario permanece como dependencia (L-05), mas a regra aditiva e fixada aqui.

### 1.5 User stories cobertas (do stories-requisitos20260606_193657.md)
| ID | Titulo | Cobertura na SPEC |
|----|--------|-------------------|
| US-00 | Provisionar a fonte Nomus no substrato | 2.4 Seed, 2.1 fontes/config_ingestao |
| US-01 | Cadastrar a credencial da fonte Nomus | 3.2 `fontes-credencial`, 4.3 hook, 5.1 |
| US-02 | Testar a conexao com o Nomus | 3.2 `fontes-testar`, 3.5 Nomus, 4.3 hook |
| US-03 | Resolver a fonte por tipo parametrizado | 3.2 (todos endpoints parametrizados), 5.2 |
| US-04 | Selecionar quais recursos do Nomus sincronizar | 2.1 config_ingestao.recursos, 3.2 `ingestao-config`, 4.2 cfg-form |
| US-05 | Selecionar quais tipos por recurso sao ingeridos | 2.1 recursos jsonb, 3.5 conector (allowlist), 4.2 |
| US-06 | Coletar processos paginados da API Nomus | 3.5 NomusConnector, 3.4 |
| US-07 | Respeitar o throttling do Nomus | 3.5 throttling, 3.4 |
| US-08 | Coletar processos das duas empresas | 2.1 nomus_processos.empresa, 3.5 |
| US-09 | Persistir processos em tabela propria com dedup | 2.1 nomus_processos, 3.4 pipeline |
| US-10 | Manter o estado do processo atualizado | 2.1 hash_conteudo/status_indexacao, 3.4 |
| US-11 | Coletar em blocos com checkpoint e continuacao | 2.1 execucoes.checkpoint, 3.4, 3.2 orquestrar |
| US-12 | Sincronizar incrementalmente por data de ultima alteracao | 3.5 janela, DD-02 |
| US-13 | Indexar conteudo textual dos processos | 2.1 memoria_chunks, 3.4 embeddings |
| US-14 | Indice de memoria agnostico de origem | 2.1 memoria_chunks (DD-01), 2.2 RLS |
| US-15 | Busca unificada com filtro de escopo | 3.2 `v1-substrato-busca-semantica`, 2.3 RPC, DD-03 |
| US-16 | Disparar coleta do Nomus sob demanda | 3.2 `ingestao-coletar`, 4.2 botao coleta |
| US-17 | Agendamento sequencial single-flight | 3.2 `ingestao-orquestrar`, 2.4 config_agendamento |
| US-18 | Bloco da fonte Nomus na tela de Fontes | 4.1/4.2 fonte-nomus-block |
| US-19 | Monitorar execucoes e erros por origem e recurso | 2.1 execucoes/erros_ingestao, 4.2 runs/erros-table |

---

## 2. Database Schema

> Convencao: campos de banco e payloads JSON em `snake_case`. Toda tabela tem RLS ativa com a policy unica do MVP `is_conta_autorizada()`.

### 2.1 Tabelas

#### 2.1.1 `fontes` (EXISTENTE - sem alteracao de schema; recebe nova linha via seed)
Registra cada fonte de dados conectada ao substrato.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| tipo | text | nao | - | UNIQUE; valores conhecidos: `effecti`, `nomus` |
| endpoint_base | text | nao | - | URL base da instancia |
| estado_conexao | text | nao | 'nao_configurada' | check em (`nao_configurada`,`conectada`,`erro`) |
| token_cifrado | text | sim | null | referencia ao segredo no Vault (nunca o segredo) |
| ativa | boolean | nao | false | participa do ciclo do orquestrador |
| ordem | int | nao | 0 | ordem de execucao no orquestrador |
| ultima_coleta_em | timestamptz | sim | null | saude da fonte |
| created_at | timestamptz | nao | now() | |
| updated_at | timestamptz | nao | now() | trigger updated_at |
- Indexes: `unique(tipo)`.
- Cobre: US-00, US-03, US-17.

#### 2.1.2 `config_ingestao` (EXISTENTE - ALTERADA: nova coluna `recursos` + `data_inicial`)
Configuracao de coleta por fonte.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| fonte_id | uuid | nao | - | FK -> fontes(id) |
| janela_dias | int | nao | 7 | janela movel default |
| data_inicial | date | sim | null | **NOVA**: janela a partir de data especifica (US-00) |
| modalidades | text[] | nao | '{}' | especifico Effecti; vazio para Nomus (RF-06) |
| portais | text[] | nao | '{}' | especifico Effecti; vazio para Nomus (RF-06) |
| recursos | jsonb | nao | '{}'::jsonb | **NOVA**: estrutura recurso->config (US-04/US-05) |
| created_at | timestamptz | nao | now() | |
| updated_at | timestamptz | nao | now() | trigger updated_at |
- **Estrutura de `recursos` (jsonb)** - mapa recurso -> objeto de config:
```json
{
  "processos": {
    "ativo": true,
    "tipos_ativos": ["Venda Governamental"],
    "usa_filtro_data_alteracao": false,
    "etapas_terminais": []
  },
  "cobranca":   { "ativo": false, "tipos_ativos": [] },
  "propostas":  { "ativo": false, "tipos_ativos": [] },
  "pedidos":    { "ativo": false, "tipos_ativos": [] },
  "nfes":       { "ativo": false, "tipos_ativos": [] },
  "contas_a_receber": { "ativo": false, "tipos_ativos": [] }
}
```
- Regras: `ativo=false` nao gera chamadas a API (RF-08); `tipos_ativos: []` num recurso ativo nao ingere nada daquele recurso (sem allowlist implicita de "todos") (US-05).
- Indexes: `index(fonte_id)`.
- Cobre: US-04, US-05, US-12.

#### 2.1.3 `nomus_processos` (NOVA)
Snapshot vigente dos processos coletados do Nomus, com dedup por `nomus_id`.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| nomus_id | text | nao | - | **UNIQUE NOT NULL** (chave de dedup) (RF-15) |
| tipo | text | sim | null | ex.: "Venda Governamental" |
| etapa | text | sim | null | estado vigente (snapshot, sem historico) |
| empresa | text | sim | null | discrimina origem (famaha/darlu); NAO compoe dedup (US-08) |
| pessoa | text | sim | null | cliente/pessoa do processo |
| nome | text | sim | null | |
| reportador | text | sim | null | |
| responsavel | text | sim | null | |
| descricao | text | sim | null | principal conteudo textual indexado |
| data_criacao | timestamptz | sim | null | data do processo na API |
| data_alteracao | timestamptz | sim | null | data de ultima alteracao (se exposta - DD-02) |
| payload_bruto | jsonb | nao | '{}'::jsonb | payload integral do GET (verbatim, nunca mutado) |
| hash_conteudo | text | sim | null | hash do conteudo textual canonico (RF-19) |
| status_indexacao | text | nao | 'pendente' | check em (`pendente`,`em_andamento`,`concluida`,`erro`) |
| created_at | timestamptz | nao | now() | |
| updated_at | timestamptz | nao | now() | trigger updated_at |
- Constraints/Indexes: `unique(nomus_id)`, `index(empresa)`, `index(tipo)`, `index(status_indexacao)`, `index(data_alteracao)`.
- Regras: NAO persiste campos personalizados (write-only na API) nem anexos (RF-18). So estado vigente, sem historico de etapas (US-10).
- **Nomes provisorios (L-01 / dep DB):** `data_criacao`, `data_alteracao` e `hash_conteudo` sao placeholders a CONGELAR apos amostra real do payload do GET `/rest/processos` (no PRD D-01 aparecem como `data_inicial`/`data_final`/`data_ultima_alteracao`/`conteudo_hash`). Mantem-se UM unico nome por campo em toda a SPEC. `data_final` (data de termino) so sera adicionada se o payload real expuser uma data de termino relevante; nesta entrega nao e modelada.
- Cobre: US-08, US-09, US-10.

#### 2.1.4 `memoria_chunks` (NOVA - indice semantico agnostico de origem - DD-01)
Indice semantico de memoria, agnostico de origem. COEXISTE com `aviso_chunks` (EXISTENTE, INTACTA: sem alteracao de schema e sem migracao nesta entrega).
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| origem | text | nao | - | **discriminador** (`aviso`, `processo`, ...) (US-14) |
| tipo | text | sim | null | discriminador fino (ex.: `processo-venda-governamental`) |
| registro_id | uuid | nao | - | ref generica ao registro de origem (ex.: nomus_processos.id); SEM FK rigida cross-tabela |
| chunk_index | int | nao | 0 | ordem do chunk no documento |
| verbatim | text | nao | - | trecho textual original |
| embedding | vector(1024) | nao | - | embedding bge-m3 |
| created_at | timestamptz | nao | now() | |
- Indexes: HNSW `vector_cosine_ops` sobre `embedding` (identico ao de `aviso_chunks`, RNF-08); `index(origem, registro_id)` (limpeza idempotente + filtro de escopo).
- `aviso_chunks` permanece intacta: zero migracao, zero regressao na busca de avisos em producao (RF-25). Nesta entrega as duas tabelas coexistem; a unificacao fica para depois.
- Cobre: US-13, US-14, US-15.

#### 2.1.5 `execucoes` (EXISTENTE - ALTERADA: checkpoint + origem/recurso)
Registro de cada execucao de coleta (observabilidade + Realtime).
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| fonte_id | uuid | sim | null | **NOVA**: FK -> fontes(id) (origem/fonte) (RF-34) |
| recurso | text | sim | null | **NOVA**: ex.: `processos` (RF-34) |
| tipo_alvo | text | sim | null | **NOVA**: ex.: "Venda Governamental" (filtro multi-origem) |
| estado | text | nao | 'em_andamento' | check (`em_andamento`,`concluida`,`erro`) |
| etapa_atual | text | sim | null | EXISTENTE |
| total_processar | int | nao | 0 | EXISTENTE |
| processados_sucesso | int | nao | 0 | EXISTENTE |
| processados_erro | int | nao | 0 | EXISTENTE |
| pendentes | int | nao | 0 | EXISTENTE |
| checkpoint | jsonb | nao | '{}'::jsonb | **NOVA**: cursor de paginacao/estado (RF-20) |
| iniciada_em | timestamptz | nao | now() | |
| concluida_em | timestamptz | sim | null | |
| updated_at | timestamptz | nao | now() | trigger updated_at |
- **Estrutura de `checkpoint` (jsonb):**
```json
{
  "pagina_atual": 12,
  "janela_inicio": "2026-05-30T00:00:00",
  "janela_fim": "2026-06-06T00:00:00",
  "modo": "incremental",
  "concluido_paginas_ate": 11,
  "fase": "coleta"
}
```
- Indexes: `index(fonte_id)`, `index(recurso)`, `index(estado)`. Realtime habilitado (publication).
- Trava single-flight: no maximo uma linha com `estado='em_andamento'` por ciclo (RF-29).
- Cobre: US-11, US-16, US-17, US-19.

#### 2.1.6 `erros_ingestao` (EXISTENTE - ALTERADA: ref generica de origem)
Erros isolados por item, sem derrubar o lote.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| execucao_id | uuid | sim | null | FK -> execucoes(id) |
| aviso_id | uuid | **sim** (era FK exclusiva) | null | mantido p/ compat Effecti |
| origem | text | nao | 'aviso' | **NOVA**: ex.: `processo-venda-governamental` (RF-34) |
| recurso | text | sim | null | **NOVA**: ex.: `processos` |
| registro_id | uuid | sim | null | **NOVA**: ref generica = nomus_processos.id (origem nomus) - NAO armazena payload (SEC-09) |
| severidade | text | nao | 'erro' | check (`aviso`,`erro`,`critico`) |
| etapa | text | sim | null | etapa do pipeline onde falhou |
| mensagem | text | nao | - | mensagem sem dados sensiveis/segredo |
| created_at | timestamptz | nao | now() | |
- Indexes: `index(execucao_id)`, `index(origem)`, `index(recurso)`.
- Cobre: US-19, RNF-05, SEC-09.

#### 2.1.7 `audit_log` (EXISTENTE - sem alteracao de schema)
Auditoria de acoes sensiveis via `logSensitiveAction`. Nunca armazena segredo nem header Basic (SEC-01, SEC-08).
| Campo | Tipo | Nullable | Default |
|-------|------|----------|---------|
| id | uuid | nao | gen_random_uuid() |
| user_id | uuid | sim | null |
| acao | text | nao | - |
| recurso | text | sim | null (ex.: `fonte:nomus`) |
| detalhe | jsonb | nao | '{}'::jsonb (sem segredo) |
| created_at | timestamptz | nao | now() |
- Cobre: US-01, US-02, US-16, SEC-08.

#### 2.1.8 `config_agendamento` (EXISTENTE - sem alteracao)
Configuracao do orquestrador global / pg_cron. Reaproveitada sem agendador novo (US-17, RF-30).
| Campo | Tipo | Nullable | Default |
|-------|------|----------|---------|
| id | uuid | nao | gen_random_uuid() |
| habilitado | boolean | nao | false |
| intervalo_cron | text | nao | '*/15 * * * *' |
| updated_at | timestamptz | nao | now() |

### 2.2 RLS Policies
> Todas as tabelas: RLS habilitada, policy unica `for all` com `USING (is_conta_autorizada())` e `WITH CHECK (is_conta_autorizada())`, deny-by-default (SEC-04). A escrita da coleta usa `service_role` (bypassa RLS) apenas server-side (SEC-05).

| Tabela | SELECT | INSERT | UPDATE | DELETE |
|--------|--------|--------|--------|--------|
| fontes | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| config_ingestao | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| nomus_processos | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| aviso_chunks | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| memoria_chunks | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| execucoes | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| erros_ingestao | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| audit_log | is_conta_autorizada() | is_conta_autorizada() | (negado) | (negado) |
| config_agendamento | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |

- `nomus_processos` e `memoria_chunks` ganham RLS conforme SEC-04 (RNF-03); `aviso_chunks` ja possui RLS e permanece intacta. `empresa` NAO e fronteira de autorizacao (SEC-07): o usuario `interno` ve as duas empresas.

### 2.3 RPCs / Funcoes
- **`set_fonte_secret(p_fonte_id uuid, p_secret text)`** (EXISTENTE) - grava a chave no Vault e retorna a referencia para `fontes.token_cifrado`. SECURITY DEFINER, executavel server-side. Nunca loga o segredo (SEC-01).
- **`get_fonte_secret(p_fonte_id uuid)`** (EXISTENTE) - le a chave do Vault em runtime; usada pela coleta/teste (SEC-01).
- **`busca_semantica_chunks(p_embedding vector(1024), p_limite int, p_escopo text DEFAULT null)`** (EXISTENTE - GENERALIZADA, DD-03):
  - Passa a ser origem-aware (union entre `aviso_chunks` e `memoria_chunks`, conforme o escopo).
  - Parametro novo `p_escopo` (OPCIONAL): `null`/`tudo` = federado; `avisos`; `processos`; ou tipo especifico (ex.: `processo-venda-governamental`).
  - Retorno ADITIVO (compat Lia): `aviso_id` (preservado), `verbatim` (preservado), `similaridade` (preservado), **+** `origem`, **+** `registro_id`.
  - Continua `SECURITY DEFINER`, executavel apenas por `service_role` (SEC-06). Usa o indice HNSW; filtro de escopo nao impede o uso do indice (RNF-08).

### 2.4 Seed Data
> Migracao/seed idempotente (US-00, RF-00). Estende o seed atual (que so cria a fonte Effecti).
- **fontes**: inserir linha idempotente
```
tipo='nomus', endpoint_base='<instancia Nomus>', estado_conexao='nao_configurada',
token_cifrado=null, ativa=true, ordem=2
```
- **config_ingestao** (para a fonte Nomus): `janela_dias=7`, `data_inicial=null`, `modalidades='{}'`, `portais='{}'`,
```json
recursos = {
  "processos": { "ativo": true, "tipos_ativos": ["Venda Governamental"], "usa_filtro_data_alteracao": false, "etapas_terminais": [] },
  "cobranca": {"ativo": false, "tipos_ativos": []},
  "propostas": {"ativo": false, "tipos_ativos": []},
  "pedidos": {"ativo": false, "tipos_ativos": []},
  "nfes": {"ativo": false, "tipos_ativos": []},
  "contas_a_receber": {"ativo": false, "tipos_ativos": []}
}
```
- **config_agendamento**: mantida a linha existente; nenhum novo agendador (RF-30).
- Resultado: `getFonteByTipo("nomus")` resolve sem 404 (US-00).

### 2.5 Diagrama ER (texto)
```
fontes (1) ─── (N) config_ingestao        [fonte_id]
fontes (1) ─── (N) execucoes              [fonte_id]   (NOVA FK)
execucoes (1) ─── (N) erros_ingestao      [execucao_id]
avisos (1) ─── (N) aviso_chunks           [aviso_id]   (EXISTENTE, intacta)
nomus_processos (1) ─── (N) memoria_chunks [registro_id, origem='processo']  (logico, sem FK rigida)
nomus_processos (1) ─── (N) erros_ingestao [registro_id=nomus_processos.id, origem='processo'] (logico)
fontes ─── Supabase Vault                 [token_cifrado = referencia ao segredo]

Notas:
- empresa em nomus_processos: discriminador, NAO chave de dedup, NAO fronteira de auth.
- memoria_chunks: tabela agnostica de origem NOVA (DD-01), coexiste com aviso_chunks intacta; registro_id+origem genericos.
- SEM correlacao explicita processo <-> aviso (RF-27).
```

---

## 3. Backend

### 3.1 Estrutura de Pastas
```
supabase/functions/
├── _shared/
│   ├── cors.ts                  (EXISTENTE - inalterado, SEC-10)
│   ├── auth.ts                  (requireAuthorizedUser, authenticateV1)
│   ├── vault.ts                 (getFonteByTipo(tipo), setFonteSecret, getFonteSecret)
│   ├── audit.ts                 (logSensitiveAction)
│   ├── embeddings.ts            (chunkText, generateAndStoreChunks, provider bge-m3)
│   ├── effecti-connector.ts     (SourceConnector, createConnector, fetchWithBackoff, parseRetryAfter, computeBackoff)
│   ├── nomus-connector.ts       (NOVO - NomusConnector implements SourceConnector)
│   ├── collected.ts             (NOVO - tipo generico CollectedRecord; CollectedAviso preservado)
│   └── hash.ts                  (NOVO - hashConteudoCanonico)
├── pipeline.ts                  (persistencia, status_indexacao, isolamento de falha por item)
├── fontes-credencial/index.ts   (PUT - parametrizado por fonte)
├── fontes-testar/index.ts       (POST - parametrizado por fonte)
├── ingestao-config/index.ts     (GET/PUT - recursos/tipos por fonte)
├── ingestao-coletar/index.ts    (POST - parametrizado fonte/recurso, checkpoint)
├── ingestao-orquestrar/index.ts (POST - ciclo sequencial single-flight)
└── v1-substrato-busca-semantica/index.ts (POST - multi-origem)
```

### 3.2 Endpoints

#### 3.2.1 PUT `fontes-credencial` (US-01, US-03)
| Campo | Valor |
|-------|-------|
| Metodo | PUT |
| Path | `/functions/v1/fontes-credencial` |
| Descricao | Grava a chave de integracao da fonte informada no Vault; persiste so a referencia. |
| Auth | Sim - `requireAuthorizedUser` ANTES de processar o corpo (SEC-02) |
| Request Body | `{ "fonte": "nomus", "token": "<chave>" }` - `fonte` validado por zod enum {`effecti`,`nomus`} (SEC-03); `token` string nao-vazia |
| Response Body | `{ "ok": true, "fonte": "nomus", "estado_conexao": "nao_configurada" }` (nunca retorna o token, RNF-01) |
| Status Codes | 200, 401 (sessao), 422 (zod: token vazio ou fonte invalida), 404 (fonte inexistente), 500 |
| Efeitos | `set_fonte_secret`, `fontes.token_cifrado=referencia`, `logSensitiveAction` sem segredo (SEC-08) |

#### 3.2.2 POST `fontes-testar` (US-02, US-03)
| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | `/functions/v1/fontes-testar` |
| Descricao | Le a chave do Vault em runtime e faz requisicao leve (`GET /rest/processos?pagina=1`) para validar credencial/endpoint. |
| Auth | Sim - `requireAuthorizedUser` (SEC-02) |
| Request Body | `{ "fonte": "nomus" }` - zod enum (SEC-03) |
| Response Body | `{ "estado_conexao": "conectada" \| "erro" \| "nao_configurada", "causa": "unauthorized" \| "rate_limited" \| "timeout" \| "unknown" \| null, "mensagem": "string", "latencia_ms": 123 }` |
| Status Codes | 200 (com estado no corpo), 401 (sessao), 422, 404, 500 |
| Regras | 401 Nomus -> `causa=unauthorized` / msg credencial invalida; 429 -> `rate_limited`; timeout -> `timeout`; credencial ausente -> `estado=nao_configurada` com orientacao; atualiza `fontes.estado_conexao`; audita sem segredo (RF-04, US-02, SEC-08) |

#### 3.2.3 GET/PUT `ingestao-config` (US-04, US-05)
| Campo | Valor |
|-------|-------|
| Metodo | GET / PUT |
| Path | `/functions/v1/ingestao-config?fonte=nomus` |
| Descricao | Le e grava `config_ingestao` da fonte (janela, recursos ativos e tipos por recurso). |
| Auth | Sim - `requireAuthorizedUser` (SEC-02) |
| Request Body (PUT) | `{ "fonte": "nomus", "janela_dias": 7, "data_inicial": null, "recursos": { "processos": { "ativo": true, "tipos_ativos": ["Venda Governamental"], "usa_filtro_data_alteracao": false }, "...": {} } }` - `fonte` zod enum; `recurso` keys validados contra allowlist {`processos`,...} (SEC-03) |
| Response Body (GET) | `{ "fonte": "nomus", "janela_dias": 7, "data_inicial": null, "recursos": {...} }` |
| Status Codes | 200, 401, 422, 404, 500 |
| Regras | governa coleta manual e agendada; vale na proxima execucao sem redeploy (RF-08); toggle auditado (SEC-08); `data_inicial` aceita no corpo mas NAO exposta na UI nesta entrega (reservada a backfill futuro); quando preenchida sobrepoe `janela_dias` |

#### 3.2.4 POST `ingestao-coletar` (US-16)
| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | `/functions/v1/ingestao-coletar` |
| Descricao | Dispara coleta manual de uma fonte/recurso; cria execucao `em_andamento` e retorna imediatamente; respeita single-flight e checkpoint. |
| Auth | Sim - `requireAuthorizedUser` (SEC-02) |
| Request Body | `{ "fonte": "nomus", "recurso": "processos" }` - `coletarSchema` zod enum: `fonte` {`effecti`,`nomus`}, `recurso` {`processos`} (SEC-03) |
| Response Body | **202** (iniciada): `{ "execucao_id": "uuid", "estado": "em_andamento" }`. **409** (ja existe execucao ativa - single-flight): `{ "execucao_id": "uuid", "estado": "em_andamento", "ja_em_andamento": true }`. A UI distingue pelo status 409 e exibe "ja existe uma coleta em andamento" |
| Status Codes | 202 (aceito/iniciado), 409 (single-flight - ja em andamento), 401, 422 (fonte/recurso invalido ou credencial Nomus ausente -> msg generica por fonte), 404, 500 |
| Regras | resolve `getFonteByTipo(fonte)`; mensagem de credencial generica por fonte; respeita `recursos`/`tipos_ativos`; progresso via Realtime de `execucoes`; auditado (US-16, RF-28, RF-29, SEC-08) |

#### 3.2.5 POST `ingestao-orquestrar` (US-17)
| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | `/functions/v1/ingestao-orquestrar` |
| Descricao | Chamado pelo pg_cron. Escolhe o proximo recurso pendente em ordem (`fontes.ordem`), avanca o checkpoint de UMA execucao por tick, retoma blocos interrompidos. |
| Auth | Sim - chamada interna autenticada (service_role / cron secret) |
| Request Body | `{}` (sem corpo) |
| Response Body | `{ "acao": "avancou" \| "iniciou" \| "ocioso" \| "concluiu", "execucao_id": "uuid" \| null, "fonte": "nomus" \| null, "recurso": "processos" \| null }` |
| Status Codes | 200, 401, 500 |
| Regras | single-flight: se houver execucao `em_andamento`, avanca o checkpoint dela e nao inicia outra (RF-29, RF-30); incrementais primeiro na ordem cadastrada, backfill em prioridade inferior preenchendo janelas ociosas (RF-31); reaproveita pg_cron/`config_agendamento`, sem agendador novo (RF-30); agendamento opcional (`config_agendamento.habilitado`); retoma automaticamente execucoes em `erro` com checkpoint valido ate o teto `NOMUS_MAX_RETOMADAS`, depois requer acao manual |

#### 3.2.6 POST `v1-substrato-busca-semantica` (US-15)
| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | `/functions/v1/v1-substrato-busca-semantica` |
| Descricao | Busca semantica multi-origem para a Lia (e cockpit), com filtro de escopo opcional. |
| Auth | Sim - `authenticateV1` (API key da Lia no Vault, escopo `read-only:busca-semantica`, OU sessao do cockpit) (SEC-06) |
| Request Body | `{ "query": "texto", "limite": 10, "escopo": "tudo" \| "avisos" \| "processos" \| "processo-venda-governamental" }` - `escopo` OPCIONAL (default `tudo`) |
| Response Body | `{ "resultados": [ { "aviso_id": "uuid \| null", "registro_id": "uuid \| null", "origem": "processo-venda-governamental", "verbatim": "texto", "similaridade": 0.87 } ] }` (campos `aviso_id`,`verbatim`,`similaridade` preservados; `origem`,`registro_id` aditivos - DD-03) |
| Status Codes | 200, 401 (API key/sessao invalida), 422 (query vazia), 500 |
| Regras | gera embedding via provider bge-m3 (RNF-09, nunca Claude); chama RPC `busca_semantica_chunks` (SECURITY DEFINER, service_role); sem filtro = federado; chunk de processo nao polui consulta de edital (filtro por similaridade + origem) (US-14, US-15); usa HNSW (RNF-08); sem vinculo processo<->aviso (RF-27); `limite` aplica o clamp ja vigente do endpoint (default 10; se inexistente no codigo, adotar min 1 / max 50); `query` nao-vazia, max 2000 chars (422 fora dos limites); valor exato do clamp a confirmar no codigo (L-05) |

### 3.3 Middleware
- **Auth middleware (`requireAuthorizedUser`)**: valida sessao Supabase (Google OAuth, perfil `interno`) ANTES de ler o corpo nos endpoints do cockpit (SEC-02). 401 quando ausente/invalida.
- **Auth `/v1` (`authenticateV1`)**: valida API key da Lia (Vault) ou sessao do cockpit; escopo read-only para a busca (SEC-06).
- **Validacao de input (zod)**: todo endpoint valida corpo com zod; `fonte`/`recurso` por enum estrito (allowlist) antes de qualquer I/O (SEC-03). Valor desconhecido -> 422, sem chamar API externa.
- **Error handler**: respostas de erro padronizadas `{ "error": "codigo", "mensagem": "texto" }`; nunca inclui segredo, token, header Basic nem payload bruto sensivel (SEC-01, SEC-09). Mensagens especificas por causa (RNF-12).
- **Rate limiting / throttling externo**: tratado no conector (3.5) - respeita 429 do Nomus, backoff em 5xx, single-flight global por estado em `execucoes` (RNF-06).
- **Logging / auditoria (`logSensitiveAction`)**: acoes sensiveis em `audit_log` sem segredo (SEC-08). Header `Authorization: Basic` nunca logado (SEC-01).

### 3.4 Pipeline de coleta (fluxo de ingestao)
> Reaproveita o PADRAO (nao o codigo literal) do Effecti; contrato de dados proprio do Nomus (RNF-17).
1. **Resolucao**: `ingestao-coletar`/`ingestao-orquestrar` resolve `getFonteByTipo(fonte)`, le `config_ingestao.recursos`, monta a janela: usa `data_inicial` (de `config_ingestao`) ate agora quando preenchida, SOBREPONDO `janela_dias`; caso contrario, janela movel de `janela_dias` (default 7). Nesta entrega `data_inicial` so e definida via seed/migracao (backfill futuro), NAO editavel na UI.
2. **Single-flight**: verifica/garante uma unica execucao `em_andamento` (RF-29). Cria/recupera linha em `execucoes` com `fonte_id`, `recurso`, `tipo_alvo`, `checkpoint`.
3. **Coleta em blocos**: `createConnector("nomus", config)` -> `NomusConnector.collect` percorre paginas a partir de `checkpoint.pagina_atual`, processa um BLOCO de paginas por execucao da Edge Function, persistindo o `checkpoint` (pagina/cursor, contadores) a cada avanco (RF-20). O BLOCO encerra quando atingir `NOMUS_BLOCO_MAX_PAGINAS` (teto de paginas, default 10) OU `NOMUS_BLOCO_MAX_MS` (orcamento de wall-clock, default 50000ms), o que ocorrer primeiro, sempre finalizando o lote corrente antes de salvar o checkpoint e retornar.
4. **Filtro de tipo (allowlist)**: descarta processos com `tipo` fora de `tipos_ativos` antes da persistencia (RF-09). Lista vazia = nada ingerido.
5. **Persistencia**: upsert em `nomus_processos` com `onConflict: nomus_id`, sobrescrevendo o estado vigente; grava `empresa`, `payload_bruto` integral (verbatim) (RF-17, US-08, US-09, US-10). Usa `service_role` server-side (SEC-05).
6. **Decisao de reindexacao (hash)**: calcula `hashConteudoCanonico` sobre os campos textuais canonicos `descricao` + `nome` + `etapa`, concatenados deterministicamente (ordem fixa e separador estavel). Inclui-se `etapa` por ser o campo que mais evolui no snapshot vigente (US-10), garantindo reindexacao quando a etapa muda. Se difere de `hash_conteudo` persistido -> `status_indexacao='pendente'` e regenera chunks; se igual -> nao reindexa (RF-19, US-10).
7. **Indexacao**: `chunkText` (sobre o texto canonico de indexacao: cabecalho `nome`/`tipo` + corpo `descricao`) + `generateAndStoreChunks` (bge-m3, `vector(1024)`) grava em `memoria_chunks` com `origem='processo'`, `tipo='processo-venda-governamental'`, `registro_id=nomus_processos.id`. Idempotente: limpa chunks antigos do registro (`origem`+`registro_id`) antes de regravar (US-13, RF-24). `payload_bruto` nunca mutado.
8. **Isolamento de falha por item**: falha de um processo vira linha em `erros_ingestao` (`origem`,`recurso`,`registro_id`,`severidade`,`etapa`,`mensagem` sem payload) e o lote continua (RNF-05, SEC-09).
9. **Continuacao/conclusao**: ao atingir o limite do bloco, retorna; o orquestrador no proximo tick avanca o `checkpoint` sem reprocessar paginas concluidas. Quando todas as paginas da janela foram processadas -> `estado='concluida'`, `concluida_em`, `fontes.ultima_coleta_em` atualizado (RF-20, RF-21, RNF-04). Falha de infra -> `estado='erro'` preservando checkpoint (RF-21). Execucoes em `erro` com checkpoint valido sao RETOMADAS automaticamente pelo orquestrador no proximo tick (respeitando single-flight), ate `NOMUS_MAX_RETOMADAS` tentativas (default 3, contador em `checkpoint.tentativas_retomada`); excedido o teto, a execucao permanece em `erro` aguardando acao manual (botao "Retomar" na UI).

### 3.5 Integracoes Externas

#### 3.5.1 API Nomus (ERP) - `NomusConnector` (US-06, US-07, US-08, US-12)
- **Base/credencial**: UMA instancia, UMA chave de integracao no Vault (SEC-01). Retorna as DUAS empresas (famaha/darlu) via campo `empresa` (US-08, RF-14).
- **Auth**: header `Authorization: Basic <chave>` + `Content-Type: application/json`. Chave lida em runtime via `getFonteSecret`; header Basic NUNCA logado (SEC-01).
- **Paginacao**: `GET /rest/processos?pagina=N` incremental a partir de 1; resposta tratada como ARRAY; pagina vazia encerra a varredura (RF-10).
- **Janela incremental (DD-02)**: caminho primario `?query=campoData>yyyy-mm-ddTHH:mm:ss` sobre data de ALTERACAO quando `usa_filtro_data_alteracao=true` (RF-22). Fallback (`false` / campo inexistente): re-scan periodico dos processos com `etapa` nao terminal alem da janela de novos (RF-23); a allowlist de etapas terminais vem de `config_ingestao.recursos.<recurso>.etapas_terminais` (valores reais a confirmar apos amostra - L-01). Janela default 7 dias, configuravel via `janela_dias` (US-12). Dependencia L-01 a confirmar com usuario.
- **Throttling (RF-13, RNF-06)**: constantes configuraveis `TAMANHO_LOTE` (default ~14 chamadas) e `PAUSA_LOTE_MS` (default ~5000ms); HTTP 429 -> aguarda `tempoAteLiberar` (segundos) e re-tenta (`parseRetryAfter`); 5xx -> backoff exponencial com no maximo `NOMUS_MAX_RETRIES` tentativas (default 5) e delay limitado por `NOMUS_BACKOFF_TETO_MS` (default 60000ms) (`computeBackoff`); esgotadas as tentativas, a falha vira registro em `erros_ingestao`; 401 -> NAO re-tenta, erro classificado `unauthorized`. Single-flight garante zero coletas concorrentes.
- **Contrato de dados (RF-12)**: `NomusConnector` produz `CollectedRecord` (tipo generico, NAO `CollectedAviso`): `{ nomus_id, tipo, etapa, empresa, pessoa, nome, reportador, responsavel, descricao, data_criacao, data_alteracao, payload_bruto }`. Cada processo preserva `id`,`tipo`,`pessoa`,`etapa`,`nome`,`reportador`,`responsavel`,`descricao`,`empresa` + payload bruto integral (US-06).
- **Factory**: `createConnector("nomus", config)` retorna o `NomusConnector`; caso `effecti` inalterado (RF-11, RNF-17).
- **Fora de escopo**: campos personalizados (write-only, indisponiveis em GET), anexos, escrita de volta (POST/PUT) (RF-18, Escopo Negativo).

#### 3.5.2 Supabase Vault
- Armazena a chave Nomus como segredo da fonte; `fontes.token_cifrado` guarda apenas referencia (SEC-01, RNF-01). Tambem armazena a API key da Lia (`/v1`).

#### 3.5.3 Provider de embeddings (bge-m3 self-hosted)
- Gera vetores `vector(1024)` na ingestao e na busca. Zero custo por token; NUNCA usa Claude na ingestao (RNF-09). Plugavel via `_shared/embeddings.ts`.

#### 3.5.4 pg_cron
- Aciona `ingestao-orquestrar` no `intervalo_cron` de `config_agendamento`. Sem fila nova nem auto-reinvocacao; sem agendador novo (RF-30, RNF-04).

---

## 4. Frontend

### 4.1 Mapa de Paginas
| Rota | Descricao | Auth |
|------|-----------|------|
| `/login` | Login via Google OAuth (EXISTENTE) | Nao |
| `/fontes` | Gestao de fontes: bloco Effecti (existente) + **bloco Nomus (novo)** com credencial, teste, recursos/tipos e coleta manual | Sim |
| `/execucoes` | Historico de execucoes com filtro por origem (Effecti x Nomus) e recurso/tipo; progresso/checkpoint ao vivo | Sim |
| `/erros` | Erros de ingestao filtraveis por origem e recurso/tipo | Sim |

> Design Lock: nenhuma NOVA tela nem item de menu e criado; as superficies Nomus entram nas paginas existentes. A inclusao passa por revisao/destrave do `manifest.json locked:true` e `src/lib/nav.ts` sem quebrar telas travadas (US-18, RF-33, RNF-13, L-04).

### 4.2 Arvore de Componentes
```
app/fontes/page.tsx
├── FonteEffectiBlock          (fonte-effecti-block.tsx - EXISTENTE, inalterado)
└── FonteNomusBlock            (fonte-nomus-block.tsx - NOVO; sai de "Fontes futuras")
    ├── CredForm               (cred-form.tsx - parametrizado por fonte) -> useSalvarCredencial, useTestarConexao
    ├── CfgForm                (cfg-form.tsx - recursos ativos + tipos por recurso + janela_dias; data_inicial nao editavel nesta entrega) -> useIngestaoConfig
    │   ├── RecursoToggle[]    (processos ativo; demais visiveis e desligados)
    │   └── TipoToggle[]       (por recurso; "Venda Governamental" ativo em processos)
    ├── ColetaButton           (dispara coleta manual) -> useColetar
    └── FonteSaude             (estado_conexao, ultima_coleta) -> useFontes

app/execucoes/page.tsx
└── ExecucoesClient            (execucoes-client.tsx - EXISTENTE, generalizado)
    ├── OrigemFiltro           (NOVO: Effecti x Nomus)
    ├── RecursoFiltro          (NOVO: recurso/tipo)
    └── RunsTable              (runs-table.tsx - colunas origem/recurso, progresso/checkpoint)

app/erros/page.tsx
└── ErrosClient                (erros-client.tsx - EXISTENTE, generalizado)
    ├── OrigemFiltro           (NOVO)
    ├── RecursoFiltro          (NOVO)
    └── ErrosTable             (erros-table.tsx - colunas origem/recurso, severidade/etapa)
```

### 4.3 Camada de API
> Fetch wrapper `@supabase/ssr` + TanStack Query 5. Tipos TS `PascalCase`; payload `snake_case`; variaveis `camelCase`. Os tipos do frontend BATEM com os response bodies do backend (3.2).

| Hook | Endpoint consumido | Params | Return type |
|------|--------------------|--------|-------------|
| `useFontes` | (query em `fontes` via Supabase) | - | `Fonte[]` `{ id, tipo, estado_conexao, ativa, ordem, ultima_coleta_em }` |
| `useSalvarCredencial` | PUT `fontes-credencial` | `{ fonte, token }` | `{ ok, fonte, estado_conexao }` |
| `useTestarConexao` | POST `fontes-testar` | `{ fonte }` | `TesteConexao` `{ estado_conexao, causa, mensagem, latencia_ms }` |
| `useIngestaoConfig` | GET/PUT `ingestao-config` | `{ fonte, janela_dias?, data_inicial?, recursos? }` | `IngestaoConfig` `{ fonte, janela_dias, data_inicial, recursos }` |
| `useColetar` | POST `ingestao-coletar` | `{ fonte, recurso }` | `{ execucao_id, estado, ja_em_andamento? }` |
| `useExecucoes` | (query `execucoes` + Realtime) | `{ origem?, recurso?, page?, pageSize? }` | `Execucao[]` `{ id, fonte_id, recurso, tipo_alvo, estado, total_processar, processados_sucesso, processados_erro, pendentes, checkpoint, iniciada_em, concluida_em }` |
| `useErros` | (query `erros_ingestao`) | `{ origem?, recurso?, page?, pageSize? }` | `ErroIngestao[]` `{ id, execucao_id, origem, recurso, registro_id, severidade, etapa, mensagem, created_at }` |
| `useBuscaSemantica` | POST `v1-substrato-busca-semantica` | `{ query, limite?, escopo? }` | `{ resultados: ResultadoBusca[] }` `{ aviso_id, registro_id, origem, verbatim, similaridade }` |

- **Realtime**: subscription na tabela `execucoes` para refletir progresso/checkpoint ao vivo, com fallback de poll (RNF-11). Atualiza `RunsTable` e `FonteSaude`.
- **Paginacao**: listas de `/execucoes` e `/erros` paginadas por offset, `pageSize` default 25, ordenadas por data desc (`iniciada_em` em execucoes; `created_at` em erros).

### 4.4 Auth Flow no Frontend
- **Login**: `/login` -> Google OAuth via Supabase Auth (`@supabase/ssr`). So perfil `interno`.
- **Session management**: sessao em cookie httpOnly gerida pelo `@supabase/ssr`; refresh automatico.
- **Protected routes**: `/fontes`, `/execucoes`, `/erros` exigem sessao; middleware Next redireciona para `/login` quando ausente.
- **Logout**: encerra sessao Supabase e limpa cookies.
- **Session expired**: chamada que retorna 401 do backend -> invalida sessao local e redireciona para `/login`.
- Mecanismo, tokens e headers IDENTICOS ao backend (Supabase Auth; `requireAuthorizedUser` valida a mesma sessao). API `/v1` da Lia usa API key separada (nao usada pelo cockpit web).

### 4.5 Design System
- **Base**: Tailwind CSS 3.4 + shadcn/ui + Lucide (icones). Reuso estrito dos componentes existentes; nenhum novo componente fora do Design Lock sem destrave (RNF-13).
- **Cores/tipografia/spacing**: herdados do tema vigente do cockpit (sem alteracao). Estados de fonte: `conectada` (verde), `erro` (vermelho), `nao_configurada` (cinza/neutro).
- **Componentes base reutilizados**: Card (blocos de fonte), Button (ColetaButton), Form/Input (cred/cfg), Switch (toggles de recurso/tipo), Table (runs/erros), Badge (estado/origem/severidade), Toast (feedback de acoes).
- Referencias visuais: nao fornecidas no PRD; manter paridade visual com o bloco Effecti.
- **Responsividade**: cockpit desktop-only nesta entrega (1.3 confirma ausencia de mobile); tabelas largas (`/execucoes`, `/erros`) usam `.tbl-wrap` com scroll horizontal. Sem garantia de layout mobile/breakpoints (registrado explicitamente).

### 4.6 Estados de UI
- **Loading**: skeleton nos blocos de fonte e nas tabelas (`RunsTable`/`ErrosTable`); botoes em estado `pending` durante mutations (salvar/testar/coletar).
- **Error**: mensagens especificas por causa no teste de conexao e na coleta (credencial invalida / rate limit / timeout / indisponibilidade), espelhando `causa`/`mensagem` do backend (RNF-12). Toast de erro em mutations.
- **Empty**: "Nenhuma execucao ainda" / "Nenhum erro registrado"; bloco Nomus `nao_configurada` orienta cadastrar a chave antes de testar/coletar.
- **Copy/Textos**: mensagens por causa (teste/coleta: credencial invalida / rate limit / timeout / indisponibilidade) e toasts de sucesso (credencial salva, conexao OK, coleta iniciada) ESPELHAM 1:1 a copy do bloco Effecti (RNF-12). Labels dos recursos exibidos na UI: Processos, Cobranca, Propostas, Pedidos, NF-es, Contas a Receber (futuros visiveis e desligados).
- **Estados especiais**: coleta `ja_em_andamento` (409 single-flight) -> aviso "ja existe uma coleta em andamento"; progresso ao vivo via Realtime (barra com `processados_sucesso`/`total_processar` e `checkpoint.pagina_atual`); execucao em `erro` que excedeu o teto de retomadas (`NOMUS_MAX_RETOMADAS`) exibe acao manual "Retomar" na `RunsTable`.

---

## 5. Security

### 5.1 Auth Flow Completo
1. **Login (cockpit)**: usuario acessa `/login` -> Google OAuth (Supabase Auth) -> sessao criada (cookie httpOnly). Apenas perfil `interno`.
2. **Acesso a endpoints do cockpit**: cada request passa por `requireAuthorizedUser` ANTES de processar o corpo (SEC-02). Falha -> 401.
3. **Validacao de input**: zod valida o corpo; `fonte`/`recurso` por enum/allowlist antes de qualquer I/O (SEC-03). Falha -> 422, sem chamar API externa.
4. **Acesso da Lia (/v1)**: `authenticateV1` valida API key (Vault, escopo `read-only:busca-semantica`) ou sessao do cockpit (SEC-06).
5. **Escrita no substrato**: somente `service_role` server-side (Edge Functions); nunca exposta ao cliente (SEC-05).
6. **Leitura de credencial externa**: chave Nomus lida do Vault em runtime (`getFonteSecret`), usada apenas no header `Authorization: Basic`, nunca logada nem retornada (SEC-01).
7. **Logout / session expired**: encerra/invalida sessao; respostas 401 redirecionam o cockpit para `/login`.
8. **Auditoria**: acoes sensiveis (cadastro/rotacao de credencial, teste de conexao, disparo de coleta, toggle de recursos/tipos) gravadas em `audit_log` via `logSensitiveAction`, sempre sem segredo/header Basic (SEC-08).

### 5.2 Checklist de Seguranca
- [ ] Session config: cookie httpOnly do Supabase Auth (Google OAuth), refresh automatico, perfil unico `interno`.
- [ ] RLS ativo em TODAS as tabelas (`fontes`, `config_ingestao`, `nomus_processos`, `aviso_chunks`, `memoria_chunks`, `execucoes`, `erros_ingestao`, `audit_log`, `config_agendamento`) com `is_conta_autorizada()` (SEC-04, RNF-03).
- [ ] CORS mantido inalterado (`_shared/cors.ts`) - sem mudanca de origens/metodos/cabecalhos (SEC-10).
- [ ] Rate limiting / throttling externo ativo no conector: respeita 429 (`tempoAteLiberar`), backoff em 5xx, single-flight global (RNF-06).
- [ ] Input validation com zod em TODOS os endpoints; `fonte`/`recurso` por allowlist enum (SEC-03).
- [ ] Allowlist de `fonte` {`effecti`,`nomus`} e `recurso` {`processos`} antes de qualquer resolucao/I/O.
- [ ] Secrets em Vault (chave Nomus + API key da Lia); nunca em `.env` de producao, nunca retornados ao cliente, nunca em log/`audit_log`, header Basic nunca logado (SEC-01, RNF-01).
- [ ] `service_role` apenas server-side; nunca exposta ao cliente (SEC-05).
- [ ] RPC `busca_semantica_chunks` permanece `SECURITY DEFINER` executavel so por `service_role` (SEC-06).
- [ ] `erros_ingestao` nao armazena payload bruto nem dados de negocio sensiveis; apenas identificador/origem/recurso/severidade/etapa (SEC-09).
- [ ] `empresa` (famaha/darlu) NAO e fronteira de autorizacao; perfil unico `interno` ve as duas (SEC-07).
- [ ] File upload validation: N/A nesta entrega (anexos fora de escopo).
- [ ] Webhook signature verification: N/A nesta entrega (sem webhooks de entrada).
- [ ] Contrato da Lia preservado (mudanca aditiva, sem breaking) na busca semantica (DD-03, RF-26).

### 5.3 .env.example
```
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # apenas server-side (Edge Functions)

# Auth (Google OAuth configurado no Supabase Auth)
# (sem segredo de OAuth no app; gerido no painel Supabase)

# Embeddings provider (bge-m3 self-hosted)
EMBEDDINGS_PROVIDER=bge-m3
EMBEDDINGS_ENDPOINT=

# Orquestrador / cron
CRON_SHARED_SECRET=               # autentica chamada interna do pg_cron ao ingestao-orquestrar

# Conector Nomus - throttling (defaults; ajustaveis sem alterar logica)
NOMUS_TAMANHO_LOTE=14
NOMUS_PAUSA_LOTE_MS=5000
NOMUS_TIMEOUT_MS=30000
NOMUS_MAX_RETRIES=5
NOMUS_BACKOFF_TETO_MS=60000

# Conector Nomus - coleta em blocos (checkpoint) e retomada
NOMUS_BLOCO_MAX_PAGINAS=10
NOMUS_BLOCO_MAX_MS=50000
NOMUS_MAX_RETOMADAS=3

# NOTA: a chave de integracao Nomus e a API key da Lia NAO vivem em .env;
# residem no Supabase Vault (SEC-01, RNF-01). endpoint_base do Nomus vive em fontes.endpoint_base.
```
