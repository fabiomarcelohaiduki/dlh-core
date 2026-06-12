# SPEC - Modulo Produtos (DLH Core)
> Gerado automaticamente pelos pipelines do LionClaw. Fonte de verdade para implementacao.
> Base: PRD20260612_101650.md + stories-requisitos20260612_101650.md (aprovados).

## 1. Resumo do Produto

### Problema, publico-alvo, pitch
- **Pitch:** O Modulo Produtos cadastra todos os produtos que a DLH trabalha em licitacao e revenda e centraliza a engenharia de custos num unico dominio estruturado dentro do DLH Core. Organiza a hierarquia Linha (segmento) -> Produto/Familia -> Variante/SKU, registra insumos e precos de fornecedor e contem o motor de calculo que transforma a composicao de custos em preco regionalizado (CIF/FOB). E a evolucao das planilhas de engenharia de custos e do catalogo usados hoje.
- **Problema (duplo):**
  1. Informacao de produto e custo dispersa em planilhas e catalogo desconectado: engenharia de custos manual, dificil de auditar e impossivel de consultar programaticamente.
  2. A IA Lia precisa avaliar editais decidindo se a DLH atende cada item, e depende de consultar de forma estruturada tres blocos do produto: PRECO (regionalizado CIF/FOB), CARACTERISTICAS e INFORMACOES PARA COTACAO. Sem cadastro estruturado e preco calculado confiavel, a Lia nao decide participacao nem recomenda produto.
- **Publico-alvo (personas):**
  - **Membro interno da DLH (operador de cadastro e custos):** cadastra/mantem Linhas, Produtos, SKUs, insumos, precos, parametros, criterios e politica; obtem preco calculado; gera documentos.
  - **Kaiane (operacao de licitacao):** gera lista de precos de licitacao e composicao de custos do pregoeiro em PDF; trabalha com precos atualizados e regionalizados.
  - **IA Lia (consumidora programatica):** consome o dominio exclusivamente via API `/v1` + busca semantica; nunca SQL bruto.

### Stack escolhida (copiada do PRD)
- **Linguagem:** TypeScript mono-linguagem ponta a ponta.
- **Frontend:** Next.js 15.5 (App Router) + React 19 + TypeScript. Tailwind CSS 3.4 + shadcn/ui (via classes CSS semanticas + design tokens em `src/app/globals.css`), Lucide icons, TanStack Query 5, react-hook-form + zod, `@supabase/ssr`. Deploy Vercel.
- **Backend:** Supabase Edge Functions (Deno/TypeScript) em `supabase/functions`, padrao `handler(req)`.
- **Substrato:** Supabase / PostgreSQL + pgvector + Auth + Storage + Edge Functions + pg_cron + Realtime + Vault. Schema `public`.
- **Autenticacao:** Supabase Auth, login via Google OAuth, perfil unico "interno", allowlist `contas_autorizadas`.
- **Embeddings:** provider plugavel, padrao bge-m3 self-hosted, `vector(1024)`, indice HNSW (`vector_cosine_ops`).

### Plataforma
- **Web** (cockpit interno autenticado, grupo de rotas `(cockpit)`). Sem mobile/desktop nativo.

### User stories cobertas (do stories-requisitos)
- **Dominio A - Hierarquia e Cadastro:** US-01 (Linha), US-02 (Produto/Familia), US-03 (SKU), US-04 (diretriz textual de producao), US-16 (fotos).
- **Dominio B - Insumos e Precos de Fornecedor:** US-05 (insumos), US-06 (precos de fornecedor).
- **Dominio C - Motor de Calculo:** US-07 (parametros 3 niveis), US-08 (calculo custo/preco regionalizado), US-09 (recalculo automatico).
- **Dominio D - Canal Revenda:** US-10 (tabelas de preco por cliente).
- **Dominio E - Criterios de Cotacao:** US-11 (diretrizes textuais), US-12 (regras estruturadas), US-24 (politica de participacao) [MVP].
- **Dominio F - Consumo pela Lia:** US-13 (API `/v1`), US-14 (busca semantica), US-23 (informacoes proativas) [pos-MVP].
- **Dominio G - Cockpit:** US-15 (operacao via telas).
- **Dominio H - Documentos/Exports:** US-17 (ficha tecnica PDF) [MVP], US-18 (composicao de custos PDF) [MVP], US-19 (lista de precos licitacao PDF) [MVP], US-20 (lista revenda PDF) [pos-MVP], US-21 (BOM PDF) [pos-MVP], US-22 (roteiro producao PDF) [pos-MVP].

> **Nota de fronteira:** formulas/coeficientes exatos do calculo custo->preco serao extraidos das planilhas `.xlsx` na fase de implementacao. A SPEC fixa a ESTRUTURA do calculo, nao os coeficientes (Lacuna conhecida do PRD).

---

## 2. Database Schema

> Banco: Supabase/PostgreSQL + pgvector, schema `public`. Dominio NOVO: apenas `CREATE TABLE` em UMA migration nova timestampada. NENHUMA tabela viva alterada (`avisos`, `aviso_chunks`, `memoria_chunks`, `execucoes`, `nomus_processos`). Padroes obrigatorios em toda tabela nova: PK `uuid default gen_random_uuid()`; RLS `is_conta_autorizada()` (USING + WITH CHECK), deny-by-default; `created_at`/`updated_at timestamptz not null default now()` com trigger `fn_set_updated_at()`; migration aditiva/idempotente. (RNF-01, RNF-05)

### 2.1 Tabelas

#### `produto_linhas` (RF-01, US-01)
Segmento de produto (ex.: Limpeza, Ergonomia). Ancora parametros e criterios no nivel Linha.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| nome | text | nao | - | UNIQUE, NOT NULL |
| descricao | text | sim | null | - |
| ativo | boolean | nao | true | - |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger fn_set_updated_at |
- Indexes: `produto_linhas_nome_key` UNIQUE(`nome`).

#### `produto_linha_atributos` (RF-02, US-01, US-02)
Define o CONJUNTO de chaves de atributo validas por Linha (atributos independentes entre Linhas).
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| linha_id | uuid | nao | - | FK -> produto_linhas(id) ON DELETE RESTRICT |
| chave | text | nao | - | NOT NULL |
| tipo | text | nao | 'texto' | CHECK in ('texto','numero','booleano') |
| obrigatorio | boolean | nao | false | - |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Indexes: UNIQUE(`linha_id`,`chave`); index(`linha_id`).
- **Evolucao de schema (US-02, RF-02):** alterar/remover um atributo da Linha NAO migra nem apaga dados de Produtos ja cadastrados. Chaves que deixam de existir no schema permanecem preservadas no JSONB `produtos.atributos`, porem sao ignoradas na renderizacao (so o schema vigente da Linha e exibido). Tornar um atributo `obrigatorio=true` nao retroage: Produtos existentes sem a chave so sao bloqueados na proxima edicao que tocar `atributos`.

#### `produtos` (RF-02, RF-04, US-02)
Produto/Familia vinculado a uma Linha. Caracteristicas como atributos flexiveis JSONB validados pelo schema da Linha.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| linha_id | uuid | nao | - | FK -> produto_linhas(id) ON DELETE RESTRICT |
| nome | text | nao | - | NOT NULL |
| atributos | jsonb | nao | '{}'::jsonb | chaves validadas na borda contra produto_linha_atributos; chaves `obrigatorio=true` da Linha sao exigidas |
| prazo_entrega | text | sim | null | - |
| disponibilidade | text | sim | null | ex.: 'sob encomenda' |
| pedido_minimo | text | sim | null | ex.: '1 pallet' |
| ativo | boolean | nao | true | - |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Indexes: index(`linha_id`).

#### `produto_skus` (RF-03, RF-05, RF-11A, US-03, US-04, US-08)
Variante/SKU de um Produto. Pode ser FABRICADO (BOM + mao de obra) ou COMPRADO (custo de aquisicao). Inclui diretriz textual de producao e tempo de producao (entrada do motor quando fabricado).
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| produto_id | uuid | nao | - | FK -> produtos(id) ON DELETE RESTRICT |
| codigo_sku | text | nao | - | UNIQUE, NOT NULL (ex.: `ELM-DF-70x100.3.240`) |
| tipo_origem | text | nao | 'fabricado' | CHECK in ('fabricado','comprado') - define a fonte de custo no motor |
| dimensoes | jsonb | sim | null | ex.: `{ "largura_cm": 70, "altura_cm": 100 }` |
| tolerancia_pct | numeric | sim | null | ex.: 5 (+/-5%) |
| acabamento | text | sim | null | ex.: 'Overlock' |
| peso_gr | numeric | sim | null | peso aproximado em gramas |
| diretriz_producao | text | sim | null | "como fazemos" (indexavel - RF-24); so faz sentido p/ `fabricado` |
| tempo_producao | numeric | sim | null | horas; entrada do calculo de mao de obra; ignorado p/ `comprado` |
| estado_calculo | text | nao | 'pendente' | CHECK in ('vigente','pendente','erro') |
| ativo | boolean | nao | true | - |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Indexes: UNIQUE(`codigo_sku`); index(`produto_id`); index(`estado_calculo`); index(`tipo_origem`).
- **Origem do SKU (US-03, US-08):** `tipo_origem='fabricado'` (default) usa `sku_composicao` (BOM) + mao de obra como base de custo. `tipo_origem='comprado'` ignora BOM/tempo de producao e usa o custo de aquisicao vigente (`sku_custo_aquisicao`) como Custo Variavel. Ambos passam pelos mesmos percentuais resolvidos -> preco regionalizado CIF/FOB.

#### `produto_imagens` (RF-05A, US-16, RNF-14)
Fotos de Produto e/ou SKU no Supabase Storage (bucket privado `produtos`).
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| produto_id | uuid | sim | null | FK -> produtos(id) ON DELETE RESTRICT |
| sku_id | uuid | sim | null | FK -> produto_skus(id) ON DELETE RESTRICT |
| storage_path | text | nao | - | NOT NULL; objeto no bucket `produtos` |
| ordem | integer | nao | 0 | - |
| legenda | text | sim | null | - |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Constraint: CHECK (`produto_id IS NOT NULL OR sku_id IS NOT NULL`).
- Indexes: index(`produto_id`); index(`sku_id`).

#### `insumos` (RF-06, US-05)
Insumos e materia-prima usados como entrada do calculo.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| nome | text | nao | - | NOT NULL |
| categoria | text | nao | - | CHECK in ('MP','embalagem','insumo') |
| unidade | text | nao | - | unidade de medida (ex.: 'kg','m','un') |
| ativo | boolean | nao | true | - |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |

#### `insumo_precos` (RF-07, US-06)
Precos de fornecedor por insumo com vigencia; historico preservado.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| insumo_id | uuid | nao | - | FK -> insumos(id) ON DELETE RESTRICT |
| fornecedor | text | sim | null | - |
| preco | numeric | nao | - | NOT NULL |
| vigencia_inicio | date | nao | now() | - |
| vigencia_fim | date | sim | null | null = vigente |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Indexes: index(`insumo_id`,`vigencia_inicio`).
- **Regra de preco vigente (US-06, RF-07):** o preco VIGENTE de um insumo e o de maior `vigencia_inicio` cuja `vigencia_fim` seja nula OU futura (>= hoje); em empate de `vigencia_inicio`, desempata pelo `created_at` mais recente. Precos historicos sao preservados. Se um insumo da composicao NAO tiver nenhum preco vigente, o motor nao calcula custo desse SKU e o coloca em `estado_calculo='erro'` (ver Dominio C / motor), sem gravar `valor`.

#### `sku_composicao` (RF-08, US-04, US-08)
BOM estruturada: composicao de insumos por SKU (UNICA definicao estruturada do dominio, consumida pelo motor).
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| sku_id | uuid | nao | - | FK -> produto_skus(id) ON DELETE RESTRICT |
| insumo_id | uuid | nao | - | FK -> insumos(id) ON DELETE RESTRICT |
| quantidade | numeric | nao | - | NOT NULL |
| unidade | text | sim | null | unidade da quantidade |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Indexes: UNIQUE(`sku_id`,`insumo_id`); index(`sku_id`); index(`insumo_id`).

#### `sku_custo_aquisicao` (US-03, US-08)
Custo de aquisicao por SKU `comprado`, com historico de vigencia (paralelo a `insumo_precos`). Aplicavel apenas a SKUs `tipo_origem='comprado'`.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| sku_id | uuid | nao | - | FK -> produto_skus(id) ON DELETE RESTRICT |
| fornecedor | text | sim | null | - |
| custo | numeric | nao | - | NOT NULL; custo de aquisicao do produto comprado |
| vigencia_inicio | date | nao | now() | - |
| vigencia_fim | date | sim | null | null = vigente |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Indexes: index(`sku_id`,`vigencia_inicio`).
- **Custo de aquisicao vigente (US-08):** o custo VIGENTE de um SKU comprado e o de maior `vigencia_inicio` cuja `vigencia_fim` seja nula OU futura (>= hoje); em empate, desempata por `created_at` mais recente (mesma regra de `insumo_precos`). Se um SKU `comprado` nao tiver custo de aquisicao vigente, o motor o coloca em `estado_calculo='erro'`, sem gravar `valor`.

#### `parametros_calculo` (RF-09, RF-10, RF-11A, US-07, US-08)
Parametros escalares de calculo com heranca em 3 niveis (uma linha por nivel/escopo).
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| nivel | text | nao | - | CHECK in ('global','linha','produto') |
| escopo_id | uuid | sim | null | null quando nivel='global'; FK logica para linha/produto |
| impostos_pct | numeric | sim | null | - |
| frete_pct | numeric | sim | null | frete medio |
| despesas_pct | numeric | sim | null | despesas estruturais |
| lucro_pct | numeric | sim | null | lucro alvo |
| taxa_horaria | numeric | sim | null | taxa horaria unica de mao de obra |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Constraint: UNIQUE(`nivel`,`escopo_id`); CHECK (`(nivel='global' AND escopo_id IS NULL) OR (nivel<>'global' AND escopo_id IS NOT NULL)`).
- Indexes: index(`nivel`,`escopo_id`). Resolucao PRODUTO -> LINHA -> GLOBAL via COALESCE no motor.

#### `parametro_regional` (RF-09, RF-10, US-07)
Vetor regional (S/SE/CO/NE/N) modelado por regiao (uma linha por regiao), permite override parcial.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| nivel | text | nao | - | CHECK in ('global','linha','produto') |
| escopo_id | uuid | sim | null | null quando nivel='global' |
| regiao | text | nao | - | CHECK in ('S','SE','CO','NE','N') |
| percentual | numeric | nao | - | NOT NULL |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Constraint: UNIQUE(`nivel`,`escopo_id`,`regiao`).
- Indexes: index(`nivel`,`escopo_id`,`regiao`). Resolucao PRODUTO -> LINHA -> GLOBAL independente por regiao.

#### `sku_precos_calculados` (RF-12, RF-14, RF-15, US-08, US-09)
Preco calculado materializado por SKU/regiao/patamar com estado e indicadores de apoio.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| sku_id | uuid | nao | - | FK -> produto_skus(id) ON DELETE RESTRICT |
| regiao | text | nao | - | CHECK in ('S','SE','CO','NE','N') |
| patamar | text | nao | - | CHECK in ('CIF','FOB') |
| valor | numeric | sim | null | preco calculado pelo motor (nunca digitado) |
| custo_base | numeric | sim | null | Custo Variavel Tecnico (rastreabilidade) |
| estado | text | nao | 'pendente' | CHECK in ('vigente','pendente','erro') |
| ifp | numeric | sim | null | Indice de Formacao de Precos (apoio, opcional) |
| preco_concorrencia | numeric | sim | null | apoio, opcional |
| custo_ideal | numeric | sim | null | apoio, opcional |
| calculado_em | timestamptz | sim | null | - |
| valor_anterior | numeric | sim | null | rastreabilidade do recalculo (US-09) |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Constraint: UNIQUE(`sku_id`,`regiao`,`patamar`).
- Indexes: UNIQUE(`sku_id`,`regiao`,`patamar`); index(`estado`) para localizar pendentes.
- **Precisao e moeda (US-08, RF-13):** moeda **BRL**. O motor calcula com precisao interna de **4 casas decimais** em custo e valores intermediarios (encadeamento de percentuais impostos -> frete -> despesas -> lucro -> ajuste regional), evitando drift de arredondamento. O `valor` final persistido e arredondado para **2 casas decimais** com **ROUND_HALF_UP**; `custo_base` mantem 4 casas para rastreabilidade. Exibicao no cockpit e nos PDFs (RF-29) usa 2 casas. O arredondamento e parte do contrato deterministico (RF-13): mesmas entradas -> mesmo `valor`.

#### `clientes_revenda` (RF-16, US-10)
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| nome | text | nao | - | NOT NULL (ex.: DAGEAL, Novo Horizonte) |
| ativo | boolean | nao | true | - |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |

#### `revenda_precos` (RF-16, RF-17, US-10)
Preco de revenda por cliente/SKU. Estrutura SEPARADA do preco de licitacao; canais nunca se misturam.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| cliente_id | uuid | nao | - | FK -> clientes_revenda(id) ON DELETE RESTRICT |
| sku_id | uuid | nao | - | FK -> produto_skus(id) ON DELETE RESTRICT |
| preco | numeric | nao | - | NOT NULL |
| vigencia_inicio | date | nao | now() | - |
| vigencia_fim | date | sim | null | null = vigente |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Indexes: index(`cliente_id`,`sku_id`,`vigencia_inicio`).
- **Com historico (US-10, RF-16):** o preco de revenda PRESERVA HISTORICO, em paralelo a `insumo_precos`. Cada par (cliente, SKU) pode ter varios registros ao longo do tempo; uma nova faixa de vigencia NAO sobrescreve a anterior (sem UNIQUE rigido em cliente/sku). O preco VIGENTE de um par (cliente, SKU) e o de maior `vigencia_inicio` cuja `vigencia_fim` seja nula OU futura (>= hoje); em empate, desempata por `created_at` mais recente. Precos historicos sao preservados para rastreabilidade.

#### `cotacao_diretrizes` (RF-18, US-11)
Diretriz textual de cotacao por LINHA ou PRODUTO (indexavel - RF-24).
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| nivel | text | nao | - | CHECK in ('linha','produto') |
| escopo_id | uuid | nao | - | FK logica para linha/produto |
| texto | text | nao | - | NOT NULL |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Indexes: index(`nivel`,`escopo_id`).

#### `cotacao_regras` (RF-19, RF-20, RF-21, US-12)
Regras estruturadas por atributo. Precedencia PRODUTO sobre LINHA (resolvida no motor).
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| nivel | text | nao | - | CHECK in ('linha','produto') |
| escopo_id | uuid | nao | - | FK logica para linha/produto |
| atributo | text | nao | - | referencia um atributo do produto/SKU |
| tipo_regra | text | nao | - | CHECK in ('faixa','opcional','substituicao') |
| valor_min | numeric | sim | null | - |
| valor_max | numeric | sim | null | - |
| substituicao | text | sim | null | substituicao permitida |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Constraint: CHECK (`valor_min IS NULL OR valor_max IS NULL OR valor_min <= valor_max`) (RF-21).
- Indexes: index(`nivel`,`escopo_id`,`atributo`).

#### `politica_participacao` (RF-21A, RF-21B, US-24) [MVP]
Politica de participacao por LINHA ou PRODUTO. Precedencia PRODUTO sobre LINHA.
| Campo | Tipo | Nullable | Default | Constraints |
|-------|------|----------|---------|-------------|
| id | uuid | nao | gen_random_uuid() | PK |
| nivel | text | nao | - | CHECK in ('linha','produto') |
| escopo_id | uuid | nao | - | FK logica para linha/produto |
| participa | text | nao | - | CHECK in ('sim','nao','condicional') |
| condicao | text | sim | null | condicao curta quando 'condicional' |
| diretriz_texto | text | sim | null | diretriz estrategica (indexavel - RF-24) |
| preferencia | text | sim | null | preferencia/prioridade OPCIONAL (so produto) |
| created_at | timestamptz | nao | now() | - |
| updated_at | timestamptz | nao | now() | trigger |
- Indexes: index(`nivel`,`escopo_id`).

#### Indexacao semantica - SEM tabela nova (RF-24, RF-25, RNF-07, RNF-13)
Reutiliza a tabela viva `memoria_chunks (origem, tipo, registro_id, chunk_index, verbatim, embedding vector(1024))` por ACOPLAMENTO LOGICO, sem FK rigida:
- `origem = 'produto'`, `tipo = 'produto-cotacao'` (escopo do dominio).
- `registro_id` aponta ao registro de origem (`cotacao_diretrizes.id`, `produto_skus.id`, `politica_participacao.id`).
- Limpeza idempotente por (`origem`,`registro_id`) reaproveitando `idx_memoria_chunks_origem_registro`.
- Conteudo indexado: `cotacao_diretrizes.texto`, `produto_skus.diretriz_producao`, `politica_participacao.diretriz_texto`.
- **Remocao de chunks (US-14, RF-24, RNF-07):** o indice semantico acompanha o ciclo de vida do registro de origem. Ao DELETAR o registro (ex.: `cotacao_diretrizes`, `politica_participacao`) OU ao esvaziar/limpar o campo de texto indexado (ex.: `diretriz_producao` -> null/vazio, `diretriz_texto` -> null/vazio), a funcao de borda REMOVE os chunks correspondentes em `memoria_chunks` por (`origem='produto'`,`registro_id`) na mesma operacao, evitando lixo semantico recuperavel pela Lia. A reindexacao ao salvar texto nao-vazio ja faz delete-then-insert por (`origem`,`registro_id`) (idempotente); o caso novo coberto aqui e o DELETE/esvaziamento, que so remove.

### 2.2 RLS Policies

> Toda tabela nova recebe RLS ativa com a policy unica `is_conta_autorizada()` (`SECURITY DEFINER`, le `auth.jwt()->>'email'`), `FOR ALL USING (is_conta_autorizada()) WITH CHECK (is_conta_autorizada())`, deny-by-default. Escrita server-side via `service_role` (bypassa RLS). (RNF-01)

| Tabela | SELECT | INSERT | UPDATE | DELETE |
|--------|--------|--------|--------|--------|
| produto_linhas | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| produto_linha_atributos | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| produtos | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| produto_skus | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| produto_imagens | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| insumos | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| insumo_precos | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| sku_composicao | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| sku_custo_aquisicao | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| parametros_calculo | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| parametro_regional | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| sku_precos_calculados | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| clientes_revenda | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| revenda_precos | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| cotacao_diretrizes | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| cotacao_regras | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |
| politica_participacao | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() | is_conta_autorizada() |

**Storage (`storage.objects`, bucket `produtos`, public=false):** 4 policies por `is_conta_autorizada()` (select/insert/update/delete), replicando o padrao do bucket `editais`. Upload via `service_role`. (Decisao Security 4, RNF-14)

### 2.3 Triggers

| Trigger | Tabela | Evento | Acao |
|---------|--------|--------|------|
| trg_set_updated_at | TODAS as 17 tabelas novas | BEFORE UPDATE | `fn_set_updated_at()` seta `updated_at = now()` |
| trg_recalc_sku_on_composicao | sku_composicao | AFTER INSERT/UPDATE/DELETE | marca SKU afetado `estado_calculo='pendente'` e enfileira recalculo (RF-15) |
| trg_recalc_sku_on_insumo_preco | insumo_precos | AFTER INSERT/UPDATE | marca SKUs cuja composicao usa o insumo como `pendente` e enfileira recalculo (US-06, RF-15) |
| trg_recalc_on_parametro | parametros_calculo | AFTER INSERT/UPDATE/DELETE | marca SKUs no escopo afetado (global/linha/produto) como `pendente` e enfileira recalculo (RF-15) |
| trg_recalc_on_parametro_regional | parametro_regional | AFTER INSERT/UPDATE/DELETE | idem para vetor regional (RF-15) |
| trg_recalc_on_sku_tempo | produto_skus | AFTER UPDATE OF tempo_producao | marca o SKU como `pendente` e enfileira recalculo (RF-15) |
| trg_recalc_on_custo_aquisicao | sku_custo_aquisicao | AFTER INSERT/UPDATE/DELETE | marca o SKU `comprado` afetado como `pendente` e enfileira recalculo (US-08, RF-15) |

> O recalculo e disparado automaticamente e de forma imediata ao salvar a mudanca, sem acao manual de propagacao (US-09, RF-15). A funcao de recalculo regrava `sku_precos_calculados` (preservando `valor_anterior`) e seta `estado_calculo='vigente'` ao concluir; `pendente`/`erro` sao transitorios.
>
> **Mecanismo de execucao do recalculo (US-09, RF-15):** o recalculo roda como **funcao SQL deterministica** (`fn_recalcular_sku(sku_id)`) executada **dentro da propria transacao do trigger** (AFTER ...), de forma sincrona e atomica - "enfileirar" significa, na pratica, invocar essa funcao para cada SKU afetado na mesma transacao. Assim, ao commitar a mudanca de entrada, o(s) preco(s) ja estao recalculados e `estado_calculo` ja reflete `vigente` (ou `erro`, conforme regras de entradas faltantes); `pendente` so persiste se a transacao do recalculo falhar. O fallback manual `POST /skus/:skuId/recalcular` (Dominio C) chama EXATAMENTE a mesma `fn_recalcular_sku`, garantindo paridade de resultado. Sem dependencia de scheduler externo (pg_cron) nem chamada assincrona (pg_net) no caminho normal. O limite de 200 itens da edicao em lote (RNF-15) contem o custo de recalculo em cascata numa unica transacao.
>
> **Entradas faltantes no calculo (US-08, RF-11) - ramifica por `tipo_origem`:**
> - **SKU `fabricado`:** entradas ESSENCIAIS sao uma composicao (`sku_composicao`) nao vazia e preco vigente para CADA insumo da composicao (regra de preco vigente em `insumo_precos`). Se a composicao estiver vazia OU algum insumo nao tiver preco vigente, o SKU vai para `estado_calculo='erro'` com motivo registrado (ex.: 'composicao vazia', 'insumo X sem preco vigente'), SEM gravar `valor`. O `tempo_producao` e TOLERANTE: quando nulo, o custo de Mao de Obra e tratado como zero e o calculo prossegue.
> - **SKU `comprado`:** o motor IGNORA BOM e tempo de producao; a entrada ESSENCIAL e o custo de aquisicao vigente (`sku_custo_aquisicao`). Sem custo de aquisicao vigente -> `estado_calculo='erro'` com motivo 'sem custo de aquisicao vigente', SEM gravar `valor`. O Custo Variavel = custo de aquisicao vigente (sem MOD/MOI).
> - **Comum:** apos o Custo Variavel ser obtido (por qualquer das duas fontes), o motor aplica os MESMOS percentuais resolvidos (impostos/frete/despesas/lucro/regional) -> preco regionalizado CIF/FOB. Apos sanar a causa do erro, o recalculo (automatico ou manual) leva o SKU de volta a `vigente`.

### 2.4 Seed Data

- **`parametros_calculo`:** 1 registro obrigatorio `nivel='global'`, `escopo_id=null` com valores padrao da empresa (impostos_pct, frete_pct, despesas_pct, lucro_pct, taxa_horaria) — sempre presente (US-07). Valores exatos a extrair das planilhas `.xlsx` (Lacuna conhecida).
- **`parametro_regional`:** 5 registros `nivel='global'`, `escopo_id=null`, um por regiao (S/SE/CO/NE/N), com percentual padrao. Valores exatos a extrair das planilhas.
- **Bucket Storage `produtos`** criado com `public=false` + 4 policies.
- Sem seed de Linhas/Produtos/Insumos (dados de operacao migrados das planilhas na fase de implementacao).

### 2.5 Diagrama ER (texto)

```
produto_linhas (1) --< produto_linha_atributos (N)   [define schema de atributos]
produto_linhas (1) --< produtos (N)            [ON DELETE RESTRICT]
produtos (1) --< produto_skus (N)              [ON DELETE RESTRICT]
produtos (1) --< produto_imagens (N)           [produto_id nullable]
produto_skus (1) --< produto_imagens (N)       [sku_id nullable]  (CHECK: ao menos um)
produto_skus (1) --< sku_composicao (N) >-- (1) insumos   [so SKU fabricado]
produto_skus (1) --< sku_custo_aquisicao (N)   [so SKU comprado; vigencia; vigente = mais recente valido]
insumos (1) --< insumo_precos (N)              [vigencia; vigente = mais recente valido]
produto_skus (1) --< sku_precos_calculados (N) [regiao x patamar = 10 linhas/SKU]
clientes_revenda (1) --< revenda_precos (N) >-- (1) produto_skus

parametros_calculo (nivel, escopo_id)   -> escopo_id referencia linha OU produto (logico)
parametro_regional (nivel, escopo_id, regiao)
cotacao_diretrizes (nivel, escopo_id)   -> linha OU produto (logico)
cotacao_regras (nivel, escopo_id, atributo)
politica_participacao (nivel, escopo_id)

memoria_chunks (tabela viva) <-- acoplamento logico (origem='produto', registro_id)
   registro_id -> cotacao_diretrizes.id | produto_skus.id | politica_participacao.id
```

---

## 3. Backend

> Edge Functions Deno em `supabase/functions`, padrao `handler(req)` com `handleCorsPreflight`, `assertMethod`, validacao zod e `logSensitiveAction`. Internas: `requireAuthorizedUser` (`_shared/auth.ts`). Consumo Lia `/v1`: `authenticateV1` (`_shared/service-auth.ts`). Cada funcao roteia por metodo/sub-path. Os paths abaixo sao logicos; cada funcao e invocada em `/functions/v1/<function-name>`.

### 3.1 Estrutura de Pastas

```
supabase/
  migrations/
    <timestamp>_produtos_schema.sql        # 17 tabelas novas, RLS, indices, triggers, seed
    <timestamp>_produtos_storage.sql       # bucket privado `produtos` + 4 policies
  functions/
    _shared/
      auth.ts                # requireAuthorizedUser (existente, reuso)
      service-auth.ts        # authenticateV1 (existente, reuso)
      cors.ts                # handleCorsPreflight, assertMethod (existente)
      audit.ts               # logSensitiveAction (existente)
      embeddings.ts          # provider plugavel bge-m3 vector(1024) (existente)
    produtos-linhas/         # CRUD produto_linhas + produto_linha_atributos
    produtos-catalogo/       # CRUD produtos + produto_skus
    produtos-imagens/        # upload/list/delete produto_imagens (Storage)
    produtos-insumos/        # CRUD insumos + insumo_precos (inclui batch)
    produtos-composicao/     # CRUD sku_composicao (fabricado) + sku_custo_aquisicao (comprado)
    produtos-parametros/     # CRUD parametros_calculo + parametro_regional + resolvidos
    produtos-precos/         # GET sku_precos_calculados + recalculo manual de fallback
    produtos-revenda/        # CRUD clientes_revenda + revenda_precos
    produtos-criterios/      # CRUD cotacao_diretrizes + cotacao_regras + politica_participacao + reindex
    produtos-documentos/     # geracao de PDFs (ficha tecnica, composicao, listas)
    v1-produtos-consulta/    # /v1 Lia: 3 blocos por produto/SKU
    v1-produtos-busca-semantica/  # /v1 Lia: busca semantica escopo 'produto-cotacao'
```

### 3.2 Endpoints

> Convencao: payloads JSON em snake_case. Auth interna = `requireAuthorizedUser`. Status comuns: 200 OK, 201 Created, 400 validacao zod, 401 sem sessao, 403 fora da allowlist, 404 nao encontrado, 405 metodo, 409 conflito (duplicata/RESTRICT), 500 erro.
>
> **Paginacao (todas as listagens GET que retornam `{ items: [...] }`):** offset-based via query params `?limit=&offset=` (`limit` default **50**, maximo **200** - acima disso 400; `offset` default **0**). A resposta inclui o total: `{ items: [...], total: number, limit: number, offset: number }`. Os filtros existentes (`?ativo=`, `?linha_id=`, etc.) sao combinaveis com a paginacao. Ordenacao default por `created_at` desc, salvo indicacao em contrario na rota.

#### Dominio A - Linhas e Atributos (`produtos-linhas`)

| Campo | Valor |
|-------|-------|
| Metodo | GET |
| Path | /produtos-linhas |
| Descricao | Lista Linhas (filtro opcional `?ativo=true`) |
| Auth | Sim |
| Request Body | - |
| Response Body | `{ items: [{ id, nome, descricao, ativo, created_at, updated_at }] }` |
| Status Codes | 200, 401, 403 |

| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | /produtos-linhas |
| Descricao | Cria Linha (nome unico) |
| Auth | Sim |
| Request Body | `{ nome, descricao? }` |
| Response Body | `{ id, nome, descricao, ativo, created_at, updated_at }` |
| Status Codes | 201, 400, 401, 403, 409 (nome duplicado) |

| Campo | Valor |
|-------|-------|
| Metodo | PUT |
| Path | /produtos-linhas/:id |
| Descricao | Edita Linha (inclui desativar via `ativo=false`) |
| Auth | Sim |
| Request Body | `{ nome?, descricao?, ativo? }` |
| Response Body | `{ id, nome, descricao, ativo, created_at, updated_at }` |
| Status Codes | 200, 400, 401, 403, 404, 409 |

| Campo | Valor |
|-------|-------|
| Metodo | DELETE |
| Path | /produtos-linhas/:id |
| Descricao | Exclui Linha. BLOQUEADO (409) se houver Produtos vinculados (RESTRICT) (US-01, RF-04A) |
| Auth | Sim |
| Request Body | - |
| Response Body | `{ ok: true }` ou `{ error: "Linha possui produtos vinculados" }` |
| Status Codes | 200, 401, 403, 404, 409 |

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST / PUT / DELETE |
| Path | /produtos-linhas/:id/atributos |
| Descricao | Gerencia o conjunto de atributos validos da Linha (`produto_linha_atributos`) |
| Auth | Sim |
| Request Body | POST/PUT: `{ chave, tipo, obrigatorio }` |
| Response Body | `{ id, linha_id, chave, tipo, obrigatorio, created_at, updated_at }` |
| Status Codes | 200/201, 400, 401, 403, 404, 409 (chave duplicada na linha) |

#### Dominio A - Produtos e SKUs (`produtos-catalogo`)

| Campo | Valor |
|-------|-------|
| Metodo | GET |
| Path | /produtos |
| Descricao | Lista Produtos, filtro `?linha_id=` (US-02) |
| Auth | Sim |
| Request Body | - |
| Response Body | `{ items: [{ id, linha_id, nome, atributos, prazo_entrega, disponibilidade, pedido_minimo, ativo, created_at, updated_at }] }` |
| Status Codes | 200, 401, 403 |

| Campo | Valor |
|-------|-------|
| Metodo | GET |
| Path | /produtos/:id |
| Descricao | Detalhe do Produto com SKUs, imagens e schema de atributos da Linha |
| Auth | Sim |
| Request Body | - |
| Response Body | `{ produto: {...}, atributos_schema: [{ chave, tipo, obrigatorio }], skus: [...], imagens: [...] }` |
| Status Codes | 200, 401, 403, 404 |

| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | /produtos |
| Descricao | Cria Produto. Exige `linha_id` valido e ativo; valida `atributos` contra schema da Linha: rejeita chave fora do schema E exige toda chave `obrigatorio=true` da Linha (US-02, RF-02) |
| Auth | Sim |
| Request Body | `{ linha_id, nome, atributos, prazo_entrega?, disponibilidade?, pedido_minimo? }` |
| Response Body | `{ id, linha_id, nome, atributos, prazo_entrega, disponibilidade, pedido_minimo, ativo, created_at, updated_at }` |
| Status Codes | 201, 400 (Linha invalida/inativa, atributo fora do schema, atributo obrigatorio ausente), 401, 403 |

| Campo | Valor |
|-------|-------|
| Metodo | PUT |
| Path | /produtos/:id |
| Descricao | Edita Produto (inclui `ativo`). Mesma validacao de `atributos` do POST: chave fora do schema e obrigatorio ausente -> 400 |
| Auth | Sim |
| Request Body | `{ nome?, atributos?, prazo_entrega?, disponibilidade?, pedido_minimo?, ativo? }` |
| Response Body | objeto Produto |
| Status Codes | 200, 400 (atributo fora do schema / obrigatorio ausente), 401, 403, 404 |

| Campo | Valor |
|-------|-------|
| Metodo | DELETE |
| Path | /produtos/:id |
| Descricao | Exclui Produto. BLOQUEADO (409) se houver SKUs vinculados (RESTRICT) (US-03, RF-04A) |
| Auth | Sim |
| Response Body | `{ ok: true }` ou `{ error: "Produto possui SKUs vinculados" }` |
| Status Codes | 200, 401, 403, 404, 409 |

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST / PUT / DELETE |
| Path | /produtos/:id/skus  (e /skus/:skuId) |
| Descricao | CRUD de SKUs de um Produto. POST valida `codigo_sku` unico e `tipo_origem` ('fabricado' default / 'comprado'); aceita `diretriz_producao` e `tempo_producao` opcionais (US-03, US-04, US-08, RF-11A) |
| Auth | Sim |
| Request Body | `{ codigo_sku, tipo_origem?, dimensoes?, tolerancia_pct?, acabamento?, peso_gr?, diretriz_producao?, tempo_producao?, ativo? }` |
| Response Body | `{ id, produto_id, codigo_sku, tipo_origem, dimensoes, tolerancia_pct, acabamento, peso_gr, diretriz_producao, tempo_producao, estado_calculo, ativo, created_at, updated_at }` |
| Status Codes | 200/201, 400 (incl. `comprado` com BOM/tempo_producao informados), 401, 403, 404, 409 (codigo_sku duplicado) |

> Ao salvar `diretriz_producao`, a funcao reindexa o chunk em `memoria_chunks` (origem='produto', tipo='produto-cotacao', registro_id=sku.id) (RF-24). Ao alterar `tempo_producao`, dispara recalculo (RF-15).
> **Origem do SKU (US-08):** `tipo_origem` so pode mudar enquanto consistente com os dados do SKU. Para `comprado`, `diretriz_producao`/`tempo_producao` nao se aplicam e a composicao (`sku_composicao`) e bloqueada; o custo entra por `sku_custo_aquisicao` (endpoints abaixo). Para `fabricado`, o custo de aquisicao nao se aplica. Alterar `tipo_origem` de um SKU com dados incompativeis ja cadastrados retorna 400 com a orientacao de limpar a fonte de custo anterior.

#### Dominio A - Imagens (`produtos-imagens`) (US-16, RF-05A, RNF-14)

| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | /produtos-imagens |
| Descricao | Upload de imagem para Produto e/ou SKU; grava objeto no bucket privado `produtos` via service_role e registra metadados |
| Auth | Sim |
| Request Body | multipart/form-data: `file`, `produto_id?`, `sku_id?`, `ordem?`, `legenda?` (ao menos um de produto_id/sku_id) |
| Response Body | `{ id, produto_id, sku_id, storage_path, ordem, legenda, created_at }` |
| Status Codes | 201, 400 (nenhum alvo, tipo/tamanho invalido), 401, 403 |

| Campo | Valor |
|-------|-------|
| Metodo | GET |
| Path | /produtos-imagens?produto_id=&sku_id= |
| Descricao | Lista imagens (com signed URL temporaria do Storage) |
| Auth | Sim |
| Response Body | `{ items: [{ id, produto_id, sku_id, storage_path, signed_url, ordem, legenda }] }` |
| Status Codes | 200, 401, 403 |

| Campo | Valor |
|-------|-------|
| Metodo | DELETE |
| Path | /produtos-imagens/:id |
| Descricao | Remove imagem (objeto + metadado); nao afeta o cadastro do Produto/SKU (US-16) |
| Auth | Sim |
| Response Body | `{ ok: true }` |
| Status Codes | 200, 401, 403, 404 |

> **Limites de upload (US-16, RF-05A):** tamanho maximo **5MB por arquivo**; tipos MIME aceitos **`image/jpeg`, `image/png`, `image/webp`**; maximo **10 fotos por Produto e 10 por SKU** (excedente rejeitado com 400). A `signed_url` de leitura retornada no GET expira em **1 hora (3600s)**. Validacao de tipo/tamanho/contagem na borda (Edge Function) antes de gravar no Storage; violacao retorna 400 com mensagem especifica.

#### Dominio B - Insumos e Precos (`produtos-insumos`)

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST / PUT / DELETE |
| Path | /insumos  (e /insumos/:id) |
| Descricao | CRUD de insumos (desativar via `ativo=false`; desativado nao selecionavel em novas composicoes). DELETE BLOQUEADO (409) se o insumo estiver referenciado em qualquer `sku_composicao` (RESTRICT, simetrico a Linha/Produto - RF-04A); insumo em uso so sai de circulacao por `ativo=false` (US-05) |
| Auth | Sim |
| Request Body | `{ nome, categoria, unidade, ativo? }` |
| Response Body | POST/PUT: `{ id, nome, categoria, unidade, ativo, created_at, updated_at }`; DELETE: `{ ok: true }` ou `{ error: "Insumo referenciado em composicao" }` |
| Status Codes | 200/201, 400, 401, 403, 404, 409 (insumo em uso na composicao) |

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST |
| Path | /insumos/:id/precos |
| Descricao | Lista/cria precos de fornecedor por insumo, com vigencia; historico preservado (US-06) |
| Auth | Sim. `logSensitiveAction` na escrita (RNF-03) |
| Request Body | `{ fornecedor?, preco, vigencia_inicio?, vigencia_fim? }` |
| Response Body | `{ id, insumo_id, fornecedor, preco, vigencia_inicio, vigencia_fim, created_at }` |
| Status Codes | 200/201, 400, 401, 403, 404 |

| Campo | Valor |
|-------|-------|
| Metodo | PUT |
| Path | /insumo-precos/batch |
| Descricao | Edicao EM LOTE de precos de insumo numa unica acao (RNF-15). Maximo **200** updates por requisicao (400 acima disso). Dispara recalculo automatico dos SKUs afetados (RF-15) |
| Auth | Sim. `logSensitiveAction` (RNF-03) |
| Request Body | `{ updates: [{ insumo_id, preco, vigencia_inicio? }] }` (1..200 itens) |
| Response Body | `{ updated: number, skus_marcados_recalculo: number }` |
| Status Codes | 200, 400 (lote vazio ou > 200 itens), 401, 403 |

#### Dominio B - Composicao (`produtos-composicao`) (US-04/US-08, RF-08)

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST / PUT / DELETE |
| Path | /skus/:skuId/composicao  (e /composicao/:id) |
| Descricao | CRUD da BOM do SKU (insumo + quantidade + unidade). SO para SKU `fabricado` (400 se o SKU for `comprado`). Insumo inativo nao selecionavel em nova linha. Alteracao dispara recalculo (RF-15) |
| Auth | Sim |
| Request Body | `{ insumo_id, quantidade, unidade? }` |
| Response Body | `{ id, sku_id, insumo_id, quantidade, unidade, created_at, updated_at }` |
| Status Codes | 200/201, 400 (SKU `comprado` nao tem BOM), 401, 403, 404, 409 (insumo ja na composicao) |

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST / PUT / DELETE |
| Path | /skus/:skuId/custo-aquisicao  (e /custo-aquisicao/:id) |
| Descricao | CRUD do custo de aquisicao do SKU `comprado`, com historico de vigencia (US-08). SO para SKU `comprado` (400 se o SKU for `fabricado`). Alteracao dispara recalculo automatico do SKU (RF-15) |
| Auth | Sim. `logSensitiveAction` na escrita (RNF-03, dado de custo) |
| Request Body | `{ fornecedor?, custo, vigencia_inicio?, vigencia_fim? }` |
| Response Body | `{ id, sku_id, fornecedor, custo, vigencia_inicio, vigencia_fim, created_at, updated_at }` (GET retorna vigente; historico com `?historico=true`) |
| Status Codes | 200/201, 400 (SKU `fabricado` nao tem custo de aquisicao), 401, 403, 404 |

#### Dominio C - Parametros (`produtos-parametros`)

| Campo | Valor |
|-------|-------|
| Metodo | GET |
| Path | /parametros?nivel=&escopo_id= |
| Descricao | Lista parametros escalares por nivel/escopo |
| Auth | Sim |
| Response Body | `{ items: [{ id, nivel, escopo_id, impostos_pct, frete_pct, despesas_pct, lucro_pct, taxa_horaria }] }` |
| Status Codes | 200, 401, 403 |

| Campo | Valor |
|-------|-------|
| Metodo | PUT |
| Path | /parametros |
| Descricao | Upsert de parametros escalares por (`nivel`,`escopo_id`). Dispara recalculo dos SKUs no escopo (RF-15) |
| Auth | Sim. `logSensitiveAction` (RNF-03, dado comercial) |
| Request Body | `{ nivel, escopo_id?, impostos_pct?, frete_pct?, despesas_pct?, lucro_pct?, taxa_horaria? }` |
| Response Body | objeto parametros |
| Status Codes | 200, 400, 401, 403 |

| Campo | Valor |
|-------|-------|
| Metodo | GET / PUT |
| Path | /parametros-regional?nivel=&escopo_id= |
| Descricao | Le/upsert do vetor regional (5 regioes). Override parcial por regiao. Dispara recalculo (RF-09, RF-10, RF-15) |
| Auth | Sim. `logSensitiveAction` na escrita |
| Request Body | `{ nivel, escopo_id?, regioes: [{ regiao, percentual }] }` |
| Response Body | `{ items: [{ id, nivel, escopo_id, regiao, percentual }] }` |
| Status Codes | 200, 400, 401, 403 |

| Campo | Valor |
|-------|-------|
| Metodo | GET |
| Path | /parametros-resolvidos?produto_id= |
| Descricao | Retorna o valor EFETIVO de cada parametro para um Produto, com o nivel de origem (efetivo vs herdado), inclusive por regiao individual (US-07, RNF-10) |
| Auth | Sim |
| Response Body | `{ escalares: { impostos_pct: { valor, origem: 'global'|'linha'|'produto' }, frete_pct: {...}, despesas_pct: {...}, lucro_pct: {...}, taxa_horaria: {...} }, regional: { S: { percentual, origem }, SE: {...}, CO: {...}, NE: {...}, N: {...} } }` |
| Status Codes | 200, 401, 403, 404 |

#### Dominio C - Precos Calculados (`produtos-precos`) (US-08, US-09)

| Campo | Valor |
|-------|-------|
| Metodo | GET |
| Path | /skus/:skuId/precos |
| Descricao | Le o preco calculado materializado (grid regiao x patamar) e o estado de calculo. Valores provem exclusivamente do motor (RF-23) |
| Auth | Sim |
| Response Body | `{ estado_calculo, precos: [{ regiao, patamar, valor, estado, calculado_em }], apoio: { ifp, preco_concorrencia, custo_ideal }, custo_base }` |
| Status Codes | 200, 401, 403, 404 |

| Campo | Valor |
|-------|-------|
| Metodo | PUT |
| Path | /skus/:skuId/precos/apoio |
| Descricao | Registra/atualiza os indicadores de apoio informados manualmente para o SKU (RF-14/US-08, "quando informados"). NAO altera `valor`/`custo_base` (exclusivos do motor, RF-23): grava apenas `ifp`, `preco_concorrencia` e `custo_ideal` na linha de `sku_precos_calculados`. Todos os campos sao opcionais; enviar `null` limpa o indicador |
| Auth | Sim. `logSensitiveAction` na escrita |
| Request Body | `{ ifp?, preco_concorrencia?, custo_ideal? }` |
| Response Body | `{ apoio: { ifp, preco_concorrencia, custo_ideal } }` |
| Status Codes | 200, 400, 401, 403, 404 |

| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | /skus/:skuId/recalcular |
| Descricao | Fallback manual para reprocessar um SKU pendente/erro (o caminho normal e automatico por trigger). Reaplica o motor deterministico (RF-13) |
| Auth | Sim |
| Response Body | `{ estado_calculo, precos: [...] }` |
| Status Codes | 200, 401, 403, 404, 500 |

| Campo | Valor |
|-------|-------|
| Metodo | GET |
| Path | /precos/pendentes |
| Descricao | Lista SKUs com `estado_calculo` pendente/erro (apoio a US-19/RF-30 e dashboards) |
| Auth | Sim |
| Response Body | `{ items: [{ sku_id, codigo_sku, estado_calculo }] }` |
| Status Codes | 200, 401, 403 |

#### Dominio D - Revenda (`produtos-revenda`) (US-10)

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST / PUT |
| Path | /clientes-revenda  (e /:id) |
| Descricao | CRUD de clientes de revenda |
| Auth | Sim |
| Request Body | `{ nome, ativo? }` |
| Response Body | `{ id, nome, ativo, created_at, updated_at }` |
| Status Codes | 200/201, 400, 401, 403, 404 |

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST / PUT / DELETE |
| Path | /clientes-revenda/:id/precos  (e /revenda-precos/:id) |
| Descricao | Tabela de precos por cliente/SKU com HISTORICO de vigencia (US-10). Estrutura SEPARADA do preco de licitacao; nunca misturados (RF-16, RF-17). GET retorna o preco vigente por SKU (e o historico quando `?historico=true`); POST cria nova faixa de vigencia sem sobrescrever as anteriores |
| Auth | Sim |
| Request Body | `{ sku_id, preco, vigencia_inicio?, vigencia_fim? }` |
| Response Body | `{ id, cliente_id, sku_id, preco, vigencia_inicio, vigencia_fim, created_at, updated_at }` |
| Status Codes | 200/201, 400, 401, 403, 404 |

#### Dominio E - Criterios e Politica (`produtos-criterios`)

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST / PUT / DELETE |
| Path | /cotacao-diretrizes?nivel=&escopo_id= |
| Descricao | CRUD de diretrizes textuais por LINHA/PRODUTO; ao salvar, reindexa em `memoria_chunks` (RF-18, RF-24) |
| Auth | Sim |
| Request Body | `{ nivel, escopo_id, texto }` |
| Response Body | `{ id, nivel, escopo_id, texto, created_at, updated_at }` |
| Status Codes | 200/201, 400, 401, 403, 404 |

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST / PUT / DELETE |
| Path | /cotacao-regras?nivel=&escopo_id= |
| Descricao | CRUD de regras estruturadas por atributo. Rejeita `valor_min > valor_max` (400) (RF-19, RF-21) |
| Auth | Sim |
| Request Body | `{ nivel, escopo_id, atributo, tipo_regra, valor_min?, valor_max?, substituicao? }` |
| Response Body | `{ id, nivel, escopo_id, atributo, tipo_regra, valor_min, valor_max, substituicao, created_at, updated_at }` |
| Status Codes | 200/201, 400 (min>max), 401, 403, 404 |

| Campo | Valor |
|-------|-------|
| Metodo | GET / POST / PUT / DELETE |
| Path | /politica-participacao?nivel=&escopo_id= |
| Descricao | CRUD da politica de participacao (flag + condicao + diretriz_texto + preferencia). Reindexa `diretriz_texto` em `memoria_chunks` (RF-21A, RF-21B, RF-24) |
| Auth | Sim |
| Request Body | `{ nivel, escopo_id, participa, condicao?, diretriz_texto?, preferencia? }` |
| Response Body | `{ id, nivel, escopo_id, participa, condicao, diretriz_texto, preferencia, created_at, updated_at }` |
| Status Codes | 200/201, 400, 401, 403, 404 |

#### Dominio H - Documentos (`produtos-documentos`)

> **Convencao de entrega (US-17..22, RF-28..33):** todos os endpoints de documento retornam o PDF como **streaming binario** na propria resposta (`Content-Type: application/pdf`, `Content-Disposition: attachment; filename=...`). O documento e **efemero**: NAO e persistido no Supabase Storage, nao gera signed URL e nao exige rotina de limpeza/retencao. Cada chamada regenera o PDF a partir dos dados vivos (atributos, fotos, motor), garantindo conteudo sempre atual. Sem custo de armazenamento.

| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | /documentos/ficha-tecnica |
| Descricao | Gera ficha tecnica de Produto em PDF (atributos + fotos), somente leitura; campos ausentes omitidos (US-17, RF-28) [MVP] |
| Auth | Sim |
| Request Body | `{ produto_id }` |
| Response Body | `application/pdf` (streaming binario efemero) |
| Status Codes | 200, 400, 401, 403, 404 |

| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | /documentos/composicao-custos |
| Descricao | Gera composicao de custos de SKU/produto em PDF no formato do pregoeiro a partir da BOM + motor; valores so do motor (US-18, RF-29) [MVP]. SO para SKU `fabricado`: SKU `comprado` nao possui BOM e retorna 422 (composicao de custos nao aplicavel) |
| Auth | Sim |
| Request Body | `{ sku_id }` |
| Response Body | `application/pdf` (streaming binario efemero). Enquanto o template oficial do pregoeiro nao existir, a estrutura de dados `{ itens, custos, percentuais, preco_final }` fica disponivel internamente para compor o PDF (Lacuna conhecida) |
| Status Codes | 200, 400, 401, 403, 404, 422 (SKU `comprado` sem BOM) |

| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | /documentos/lista-precos-licitacao |
| Descricao | Gera lista de precos de licitacao em PDF (CIF/FOB por regiao) dos SKUs selecionados; sinaliza pendentes de recalculo (US-19, RF-30) [MVP] |
| Auth | Sim |
| Request Body | `{ sku_ids: [uuid] }` |
| Response Body | `application/pdf` (streaming binario efemero) |
| Status Codes | 200, 400, 401, 403 |

| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | /documentos/lista-precos-revenda \| /documentos/bom \| /documentos/roteiro-producao |
| Descricao | Lista revenda (US-20/RF-31), BOM (US-21/RF-32), roteiro de producao (US-22/RF-33). [pos-MVP]. BOM e roteiro de producao SO se aplicam a SKU `fabricado` (SKU `comprado` retorna 422); lista de revenda independe da origem |
| Auth | Sim |
| Request Body | `{ cliente_id }` \| `{ sku_id }` \| `{ sku_id }` |
| Response Body | `application/pdf` (streaming binario efemero) |
| Status Codes | 200, 400, 401, 403, 404, 422 (BOM/roteiro de SKU `comprado`) |

#### Dominio F - Consumo pela Lia `/v1`

| Campo | Valor |
|-------|-------|
| Metodo | GET |
| Path | /v1-produtos-consulta?sku_id=  (ou ?produto_id=) |
| Descricao | Retorna os 3 blocos do produto/SKU: PRECO (CIF/FOB por regiao, do motor), CARACTERISTICAS (atributos + comercial) e INFORMACOES PARA COTACAO (criterios + politica de participacao). NAO expoe BOM, taxa horaria, percentuais nem lucro (Decisao Security 2). (US-13, RF-22, RF-23) |
| Auth | Sim - `authenticateV1` (API key de servico no Vault `LIA_SERVICE_API_KEY` OU sessao do cockpit). `logSensitiveAction` registrando principal + escopo (RNF-03) |
| Request Body | - |
| Response Body | `{ version: "v1", produto: { id, nome, linha }, sku: { id, codigo_sku, tipo_origem, dimensoes, tolerancia_pct, acabamento, peso_gr }, preco: { regioes: { S: { CIF, FOB }, SE: {...}, CO: {...}, NE: {...}, N: {...} }, estado_calculo }, caracteristicas: { atributos, prazo_entrega, disponibilidade, pedido_minimo }, informacoes_cotacao: { diretrizes: [...], regras: [...], politica: { participa, condicao, diretriz_texto, preferencia } } }` (`tipo_origem` informa fabricado/comprado sem expor a fonte de custo - Decisao Security 2 preservada) |
| Status Codes | 200, 401 (sem credencial), 403 (sessao humana fora da allowlist), 404 |

> **Preco nao-vigente (US-13, RF-22):** o `/v1` NUNCA bloqueia nem oculta o bloco PRECO por causa do estado de calculo - prioriza transparencia para a Lia decidir. Sempre retorna o ultimo `valor` disponivel por regiao/patamar JUNTO com `estado_calculo` explicito (`vigente`/`pendente`/`erro`). Quando `pendente`: os valores podem estar desatualizados (entrada mudou e o recalculo ainda nao concluiu) - a Lia ve `pendente` e decide se confia. Quando `erro` (ex.: composicao vazia ou insumo sem preco vigente, ver Dominio C): nao ha `valor` gravado, entao os campos `CIF`/`FOB` vem `null` e `estado_calculo='erro'` sinaliza a indisponibilidade. O HTTP permanece **200** nesses casos (o estado vai no corpo, nao no status).

| Campo | Valor |
|-------|-------|
| Metodo | POST |
| Path | /v1-produtos-busca-semantica |
| Descricao | Busca semantica de criterios/diretrizes/producao do dominio Produtos. Gera embedding bge-m3 vector(1024) da query e chama a RPC `busca_semantica_chunks(p_embedding, p_limite, p_escopo='produto-cotacao')` (ramo `m.tipo = p_escopo`), isolando o dominio (US-14, RF-24, RF-25) |
| Auth | Sim - `authenticateV1`. `logSensitiveAction` |
| Request Body | `{ query: string, limite?: number }`. `query` obrigatoria, 1..**2000** caracteres (400 acima). `limite` default **10**, maximo **50** (valores acima sao rejeitados com 400). Escopo fixo do dominio = `produto-cotacao`; enum `/v1` estendido para reconhecer o tipo |
| Response Body | `{ version: "v1", resultados: [{ registro_id, tipo, verbatim, similaridade }] }` |
| Status Codes | 200, 400 (query vazia/> 2000 chars, limite > 50), 401, 403 |

### 3.3 Middleware

- **`handleCorsPreflight`** (`_shared/cors.ts`): responde OPTIONS com CORS allowlist; aplicado em toda Edge Function.
- **`assertMethod`**: valida o metodo HTTP esperado por rota; 405 caso contrario.
- **`requireAuthorizedUser`** (`_shared/auth.ts`): em funcoes internas, SEMPRE antes de processar o corpo. Bearer token -> `getUser` -> checagem da allowlist via `service_role` -> `signOut` + 403 quando fora; 401 sem sessao (RNF-02).
- **`authenticateV1`** (`_shared/service-auth.ts`): em `/v1`, aceita `LIA_SERVICE_API_KEY` (Vault, comparacao `timingSafeEqual`) OU sessao humana; 401 sem credencial, 403 sessao fora da allowlist (RNF-02).
- **Validacao zod**: schema por endpoint; 400 com mensagem especifica (RNF-11). Validacoes equivalentes ao frontend.
- **`logSensitiveAction`** (`_shared/audit.ts`): escrita de parametros de custo, escrita de precos de insumo e cada acesso ao `/v1` (principal + escopo, sem vazar valores/API key) (RNF-03, Decisao Security 3).
- **Error handler**: respostas de erro padronizadas `{ error: string, code?: string }`; nunca cria registro parcial em erro de validacao (RNF-11).

### 3.4 Agent Graph (se aplicavel)

Nao se aplica. O Modulo Produtos NAO contem um agente de IA com grafo de nos/estado. A interacao da IA Lia ocorre EXCLUSIVAMENTE como consumidora externa via endpoints `/v1` (consulta estruturada + busca semantica). A logica proativa da Lia (US-23, bloco de insights e notificacoes) e **pos-MVP** e, quando implementada, consome os mesmos endpoints `/v1` em modo somente leitura, sem alterar cadastro.

### 3.5 Integracoes Externas

- **Provider de embeddings bge-m3** (plugavel, self-hosted, `vector(1024)`): usado na indexacao de chunks e na geracao do embedding de query da busca semantica (`_shared/embeddings.ts`). Mesmo provider usado na ingestao.
- **Supabase Storage** (bucket privado `produtos`): upload/leitura de fotos via signed URLs; escrita via `service_role`.
- **Supabase Vault**: armazena `LIA_SERVICE_API_KEY` (escopo `read-only:busca-semantica`, reuso da key existente - Decisao Security 1).
- **RPC `busca_semantica_chunks`** (`SECURITY DEFINER`, somente `service_role`): consumida pelo `/v1-produtos-busca-semantica` passando `p_escopo='produto-cotacao'`.
- Sem integracoes de pagamento, webhooks de terceiros ou SDKs externos no escopo do MVP. (Integracao Nomus = candidata pos-MVP, fora do escopo.)

---

## 4. Frontend

> Next.js 15.5 App Router, grupo de rotas autenticadas `(cockpit)`. Estilizacao por CLASSES CSS SEMANTICAS + design tokens em `src/app/globals.css` (`.screen`, `.page-head`, `.titles`, `.card`, `.btn`; tokens `--bg/--surface/--accent/--ok/--warn/--err`). Dados via TanStack Query (`src/hooks/use-*.ts`) com `queryKeys` namespaced; hidratacao server-side em `page.tsx` via `createClient` (server) sob RLS; mutacoes via `src/lib/api/*`. Formularios react-hook-form + zod. Componentes novos em `src/components/cockpit/produtos/` (kebab-case). (RF-26)

### 4.1 Mapa de Paginas

> Novo GRUPO `Produtos` no sidebar (exige revisao explicita do Design Lock: `src/lib/nav.ts` + `design-contract.json`) (RF-27, US-15). Padrao "1 item de menu = 1 tela".

| Rota | Item de menu | Descricao | Auth |
|------|--------------|-----------|------|
| `/produtos` | Linhas & Produtos | Master-detail: lista de Linhas -> Produtos da Linha (drill-down). Form de Linha define o conjunto de atributos (pares chave-valor). Bloco 1 (US-01..04, US-16) | Sim |
| `/produtos/[produtoId]` | (detalhe, sem menu) | Pagina densa do Produto: atributos flexiveis (renderizados do schema da Linha), campos comerciais, sub-secao de SKUs, criterios de cotacao, politica de participacao, fotos e grid de preco calculado (Decisao Frontend 2/3) | Sim |
| `/insumos` | Insumos & Precos | Insumos (categoria, unidade, ativo) + precos de fornecedor com vigencia e destaque do vigente; edicao em lote de precos (RNF-15); composicao do SKU no detalhe. Bloco 2 (US-05, US-06, RF-08) | Sim |
| `/parametros-custo` | Parametros de custo | Parametros 3 niveis (impostos, frete, despesas, lucro, taxa horaria, vetor regional) + indicador efetivo/herdado + grid regional x patamar com `status-pill` de estado. Bloco 3 (US-07..09, RNF-10) | Sim |
| `/revenda` | Revenda | Clientes de revenda + tabelas de preco por cliente/SKU. Bloco 4-revenda (US-10) | Sim |

> Criterios de cotacao + politica de participacao (Bloco 4, US-11/US-12/US-24) sao operados dentro do detalhe do Produto (`/produtos/[produtoId]`) e tambem no nivel Linha (em `/produtos` ao abrir uma Linha).
> **Fase seguinte de UI (pos espinha dorsal):** exports em PDF (US-17/18/19) e bloco de insights/notificacoes proativas da Lia (US-23, pos-MVP) exigem nova revisao do Design Lock.

### 4.2 Arvore de Componentes

```
src/components/cockpit/produtos/
  linhas-table.tsx              # lista de Linhas (status ativo/inativo)
  linha-form.tsx                # criar/editar Linha (inline em card, padrao cfg-form)
  atributos-editor.tsx          # pares chave-valor dinamicos: define atributos da Linha
  produto-detalhe-client.tsx    # client da pagina densa /produtos/[produtoId]
  produto-form.tsx              # dados do Produto + atributos flexiveis (render do schema)
  sku-form.tsx                  # SKU: tipo_origem (fabricado/comprado), dimensoes, tolerancia, acabamento, peso, diretriz, tempo (diretriz/tempo so p/ fabricado)
  fotos-uploader.tsx            # upload/ordem/legenda de fotos (Produto/SKU)
  insumos-table.tsx             # lista de insumos
  insumo-precos-lote-form.tsx   # edicao EM LOTE de precos (RNF-15)
  composicao-editor.tsx         # BOM do SKU fabricado: seletor de insumo + quantidade/unidade
  custo-aquisicao-form.tsx      # custo de aquisicao do SKU comprado (fornecedor + custo + vigencia, com historico)
  parametros-form.tsx           # parametros 3 niveis + indicador efetivo/herdado
  preco-regional-grid.tsx       # grid 5 regioes x CIF/FOB + status-pill de estado + acao "Recalcular" (use-recalcular-sku) quando pendente/erro
  apoio-precos-form.tsx         # captura manual dos indicadores de apoio (ifp, preco_concorrencia, custo_ideal) do SKU (use-apoio-precos); read-only para valor/custo_base do motor
  precos-pendentes-list.tsx     # bloco de apoio: SKUs com estado_calculo pendente/erro (use-precos-pendentes) + atalho de recalculo manual
  criterios-form.tsx            # diretrizes textuais (Linha/Produto)
  regras-estruturadas-form.tsx  # regras por atributo (faixa/opcional/substituicao)
  politica-participacao-form.tsx# flag participa + condicao + diretriz + preferencia
  clientes-revenda-table.tsx    # clientes de revenda
  revenda-precos-form.tsx       # tabela de precos por cliente/SKU

# Reuso (existentes): status-pill (ok/run/warn/err/idle), stat-card, tabelas, screen-placeholder
```

### 4.3 Camada de API

> `src/lib/api/` chama as Edge Functions internas via `client.ts`/proxy existente. Tipos em `src/lib/api/types.ts` (PascalCase). Hooks em `src/hooks/` com `queryKeys` namespaced e invalidacao em mutacao (padrao `use-fontes`).

| Modulo `src/lib/api` | Hook (`src/hooks`) | Endpoint consumido | Params | Return type (TS) |
|----------------------|--------------------|--------------------|--------|------------------|
| produtos.ts | use-linhas | GET/POST/PUT/DELETE /produtos-linhas | `{ ativo? }` | `ProdutoLinha[]` |
| produtos.ts | use-linha-atributos | /produtos-linhas/:id/atributos | `linhaId` | `LinhaAtributo[]` |
| produtos.ts | use-produtos | GET /produtos?linha_id | `{ linhaId? }` | `Produto[]` |
| produtos.ts | use-produto | GET /produtos/:id | `produtoId` | `ProdutoDetalhe` |
| produtos.ts | use-skus | /produtos/:id/skus | `produtoId` | `ProdutoSku[]` |
| produtos.ts | use-fotos | /produtos-imagens | `{ produtoId?, skuId? }` | `ProdutoImagem[]` |
| insumos.ts | use-insumos | /insumos | `{ ativo? }` | `Insumo[]` |
| insumos.ts | use-insumo-precos | /insumos/:id/precos, /insumo-precos/batch | `insumoId` | `InsumoPreco[]` |
| insumos.ts | use-composicao | /skus/:skuId/composicao | `skuId` | `SkuComposicaoItem[]` |
| insumos.ts | use-custo-aquisicao | /skus/:skuId/custo-aquisicao | `skuId` | `SkuCustoAquisicao[]` |
| parametros.ts | use-parametros | /parametros, /parametros-regional | `{ nivel, escopoId? }` | `ParametrosCalculo`, `ParametroRegional[]` |
| parametros.ts | use-parametros-resolvidos | GET /parametros-resolvidos | `produtoId` | `ParametrosResolvidos` |
| parametros.ts | use-precos-calculados | GET /skus/:skuId/precos | `skuId` | `PrecoCalculadoGrid` |
| parametros.ts | use-apoio-precos (mutation) | PUT /skus/:skuId/precos/apoio | `{ skuId, ifp?, preco_concorrencia?, custo_ideal? }` | `{ apoio: PrecoApoio }` (invalida `use-precos-calculados`) |
| parametros.ts | use-recalcular-sku (mutation) | POST /skus/:skuId/recalcular | `skuId` | `PrecoCalculadoGrid` (invalida `use-precos-calculados` e `use-precos-pendentes`) |
| parametros.ts | use-precos-pendentes | GET /precos/pendentes | — | `PrecoPendente[]` |
| criterios.ts | use-criterios | /cotacao-diretrizes, /cotacao-regras | `{ nivel, escopoId }` | `CotacaoDiretriz[]`, `CotacaoRegra[]` |
| criterios.ts | use-politica | /politica-participacao | `{ nivel, escopoId }` | `PoliticaParticipacao` |
| revenda.ts | use-revenda | /clientes-revenda, /clientes-revenda/:id/precos | `{ clienteId? }` | `ClienteRevenda[]`, `RevendaPreco[]` |
| documentos.ts | use-documentos (mutations) | POST /documentos/* | conforme doc | `Blob` PDF (streaming binario efemero; aciona download no cliente) |

> **Tipos (consistencia banco -> endpoint -> frontend):** payloads em snake_case; tipos TS em PascalCase com campos em snake_case espelhando o JSON (ex.: `ProdutoSku = { id: string; produto_id: string; codigo_sku: string; estado_calculo: 'vigente'|'pendente'|'erro'; ... }`). O grid de preco usa `PrecoCalculadoGrid = { estado_calculo; precos: { regiao: 'S'|'SE'|'CO'|'NE'|'N'; patamar: 'CIF'|'FOB'; valor: number; estado: ... }[] }`. A lista de pendentes usa `PrecoPendente = { sku_id: string; codigo_sku: string; estado_calculo: 'pendente'|'erro' }`. Os indicadores de apoio usam `PrecoApoio = { ifp: number | null; preco_concorrencia: number | null; custo_ideal: number | null }` — mesmos campos snake_case do request/response de PUT `/skus/:skuId/precos/apoio` e do bloco `apoio` do GET `/skus/:skuId/precos`. Nenhum endpoint que retorna `created_at` e lido como `createdAt` no frontend — os campos JSON permanecem snake_case.
> A camada de frontend NAO consome `/v1` (esse contrato e exclusivo da Lia/servico).

### 4.4 Auth Flow no Frontend

- **Login:** Supabase Auth via Google OAuth (`@supabase/ssr`). Botao "Entrar com Google" -> redirect OAuth -> callback cria sessao (cookie httpOnly via `@supabase/ssr`).
- **Sessao:** `createClient` (server) em `page.tsx` para hidratacao server-side sob RLS; `createBrowserClient` no client para mutacoes. Token Bearer enviado pelo proxy as Edge Functions.
- **Protected routes:** grupo `(cockpit)` exige sessao; middleware/layout redireciona para login se sessao ausente/expirada. Allowlist `contas_autorizadas` verificada na borda (Edge Function) — usuario fora da allowlist recebe 403 e e deslogado (`signOut`).
- **Registro:** nao ha auto-registro. Acesso e por allowlist `contas_autorizadas` (e-mail OU dominio, `ativo=true`); perfil unico "interno". (Escopo negativo do PRD: sem novos perfis/login externo.)
- **Logout:** `signOut` limpa a sessao; redireciona para login.
- **Session expired:** chamada que retorna 401 invalida o cache e redireciona para login.

### 4.5 Design System

- **Cores (tokens em `src/app/globals.css`):** base zinc off-black + acento ambar. Tokens `--bg`, `--surface`, `--accent` (ambar), `--ok` (verde), `--warn` (ambar/laranja), `--err` (vermelho). Sem utilitarios Tailwind soltos nem novo sistema de estilos.
- **Tipografia/spacing:** herdados do globals.css existente (classes `.screen`, `.page-head`, `.titles`, `.card`, `.btn`).
- **Componentes base reaproveitados:** `status-pill` (ok/run/warn/err/idle) — usado para `estado_calculo` (vigente=ok, pendente=warn, erro=err); `stat-card`; tabelas; `screen-placeholder`.
- **Padroes de tela:** master-detail com drill-down (estilo `edital/[avisoId]`); formularios inline em cards (`cfg-form`/`cred-form`) para entidades simples; pagina dedicada para o detalhe denso de Produto/SKU.
- **Referencias visuais:** segue identidade visual ja existente do cockpit; nenhuma nova area visual fora do Design Lock sem revisao (RF-27).

### 4.6 Estados de UI

- **Loading:** skeleton/placeholder nas tabelas e cards durante fetch TanStack Query; `screen-placeholder` em paginas vazias.
- **Error:** mensagem de erro especifica vinda do endpoint (ex.: "Linha possui produtos vinculados", "SKU duplicado", "minimo maior que maximo"); validacao zod inline nos formularios (RNF-11). Sem criar registro parcial.
- **Empty:** estado vazio em listas (sem Linhas/Produtos/Insumos) com call-to-action de cadastro.
- **Estado de calculo:** `status-pill` por SKU no `preco-regional-grid` — vigente (ok), pendente de recalculo (warn), erro (err). Reflete `estado_calculo`; pendente/erro tratados como transitorios (US-09). Quando o estado e `pendente`/`erro`, o `preco-regional-grid` exibe uma acao "Recalcular" ao lado do `status-pill` que dispara `use-recalcular-sku` (POST `/skus/:skuId/recalcular`) — fallback manual do motor (US-09/RF-13); durante a mutacao o pill vai para `run` e, ao concluir, o grid e a lista de pendentes sao invalidados.
- **Pendentes de recalculo:** a tela de Parametros/Precos (`/parametros-custo`) consome `use-precos-pendentes` (GET `/precos/pendentes`) para listar os SKUs com `estado_calculo` pendente/erro num bloco de apoio (US-19/RF-30), cada item com `status-pill` e atalho para o recalculo manual acima.
- **Atributos dinamicos:** quando a Linha nao define atributos, o `atributos-editor`/`produto-form` mostra estado vazio orientando definir atributos na Linha.
- **Efetivo vs herdado:** em `parametros-form`, badge indicando a origem (GLOBAL/LINHA/PRODUTO) de cada valor efetivo, inclusive por regiao (RNF-10).
- **Fotos:** preview de upload, ordenacao e estado de "sem fotos"; remocao nao afeta o cadastro.

---

## 5. Security

### 5.1 Auth Flow Completo

1. **Acesso ao cockpit (humano):** usuario abre `(cockpit)` -> sem sessao, redireciona para login -> "Entrar com Google" -> OAuth Supabase -> callback cria sessao (cookie httpOnly via `@supabase/ssr`).
2. **Hidratacao server-side:** `page.tsx` usa `createClient` (server) que aplica RLS `is_conta_autorizada()` — usuario fora da allowlist nao le dados.
3. **Mutacao:** frontend chama `src/lib/api/*` -> proxy envia Bearer token a Edge Function interna -> `requireAuthorizedUser` valida: `getUser` -> checagem allowlist via `service_role` -> processa. Fora da allowlist: `signOut` + 403. Sem sessao: 401.
4. **Consumo pela Lia (`/v1`):** servico envia `LIA_SERVICE_API_KEY` (Vault) OU sessao humana -> `authenticateV1` (comparacao `timingSafeEqual`). Sem credencial: 401. Sessao humana fora da allowlist: 403. Acesso auditado por `logSensitiveAction` (principal + escopo).
5. **Session expired:** qualquer 401 invalida cache e redireciona para login.
6. **Logout:** `signOut` limpa sessao -> redireciona para login.

> Sem auto-registro: acesso controlado pela allowlist `contas_autorizadas`. Perfil unico "interno"; sem RBAC granular (single-profile por design).

### 5.2 Checklist de Seguranca

- [x] **Session config:** cookies httpOnly via `@supabase/ssr`; expiracao gerida pelo Supabase Auth; refresh automatico.
- [x] **RLS ativo em todas as tabelas:** 17 tabelas novas com `is_conta_autorizada()` (USING + WITH CHECK), deny-by-default (RNF-01).
- [x] **CORS configurado:** `handleCorsPreflight` com allowlist em toda Edge Function.
- [ ] **Rate limiting:** nao especificado no PRD; herdar limites de plataforma (Supabase Edge / Vercel). Avaliar limite por principal no `/v1` se necessario (item de hardening, fora do escopo do MVP).
- [x] **Input validation em todos os endpoints:** zod por endpoint, equivalente ao frontend; mensagens especificas; sem registro parcial (RNF-11).
- [ ] **Webhook signature verification:** N/A — sem webhooks de terceiros no escopo.
- [x] **Secrets em env vars / Vault:** `LIA_SERVICE_API_KEY` apenas como referencia no Vault; `service_role` apenas server-side; nunca exposto ao cliente (RNF-04).
- [x] **File upload validation:** fotos validadas por tipo (`image/jpeg`, `image/png`, `image/webp`), tamanho (max 5MB/arquivo) e contagem (max 10 por Produto e 10 por SKU) na borda; bucket privado `produtos` (public=false) com 4 policies `is_conta_autorizada()`; upload via `service_role`; sem leitura publica anonima (signed URLs com TTL 1h) (RNF-14, Decisao Security 4).
- [x] **Minimizacao de dado sensivel (Decisao Security 2):** `/v1` NAO expoe BOM, taxa horaria, percentuais de custo nem lucro alvo — apenas PRECO, CARACTERISTICAS e INFORMACOES PARA COTACAO. Dados de margem/composicao acessiveis somente pela sessao humana no cockpit.
- [x] **Auditoria (Decisao Security 3):** `logSensitiveAction` em escrita de parametros de custo, escrita de precos de insumo e cada acesso ao `/v1` (sem vazar valores/API key) (RNF-03).
- [x] **Integridade hierarquica:** FKs `ON DELETE RESTRICT` (Linha->Produto, Produto->SKU); retirada de circulacao por `ativo=false` (RF-04A).

### 5.3 .env.example

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>     # server-side only, nunca no cliente

# Auth (Google OAuth via Supabase Auth)
# (configurado no painel Supabase Auth; allowlist em contas_autorizadas)

# Embeddings (provider plugavel bge-m3)
EMBEDDINGS_PROVIDER_URL=<url-bge-m3>
EMBEDDINGS_MODEL=bge-m3
EMBEDDINGS_DIMENSIONS=1024

# Lia / servico (referencia ao Vault, nao valor literal)
LIA_SERVICE_API_KEY=<referencia-no-vault>        # escopo read-only:busca-semantica (reuso)

# Storage
SUPABASE_STORAGE_BUCKET_PRODUTOS=produtos        # bucket privado (public=false)
```

---

> **Lacunas conhecidas herdadas do PRD (a resolver na implementacao):** formulas/coeficientes exatos do calculo custo->preco (extracao das planilhas `.xlsx`); estrutura interna exata das tabelas de revenda (DAGEAL, Novo Horizonte); atributos elegiveis a regras estruturadas por Linha; template oficial da composicao de custos do pregoeiro (US-18/RF-29). A SPEC fixa a ESTRUTURA; coeficientes e templates sao definidos na fase de implementacao.
