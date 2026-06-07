# CLAUDE.md - DLH Core

> Gerado pelo Feature Discovery Agent em 2026-06-06 a partir da analise do repositorio.
> Documento de contexto para agentes. Atualize quando a arquitetura mudar.

## Visao geral

DLH Core e o primeiro componente do ecossistema DLH: um **substrato de memoria operacional** (modelado pela MOE, sobre Supabase) alimentado por um **cockpit de ingestao** de uso interno. Fase 1 (MVP) entrega o modulo de Ingestao com um unico conector ativo (portal Effecti): coleta avisos/editais de licitacao via API oficial, baixa e trata arquivos (PDF, OCR, ZIP, RAR, DOC/DOCX), preserva conteudo literal verbatim, indexa para busca semantica (embeddings) e persiste tudo integralmente. O conhecimento e consumido pela IA Lia via API/MCP LLM-ready (nunca SQL bruto).

## Stack detectada

- **Linguagem:** TypeScript mono-linguagem ponta a ponta.
- **Frontend:** Next.js 15.5 (App Router) + React 19 + TypeScript. Tailwind CSS 3.4 + shadcn/ui (componentes em `src/components/ui`), Lucide icons, TanStack Query 5, react-hook-form + zod, `@supabase/ssr`. Deploy alvo Vercel.
- **Backend:** Supabase Edge Functions (Deno/TypeScript) em `supabase/functions`.
- **Substrato:** Supabase / PostgreSQL + pgvector + Auth + Storage + Edge Functions + pg_cron + Realtime + Vault.
- **Autenticacao:** Supabase Auth, login exclusivamente via Google (OAuth). Perfil unico no MVP ("interno").
- **Embeddings:** provider plugavel, padrao bge-m3 self-hosted, `vector(1024)`, indice HNSW (vector_cosine_ops).

## Estrutura de pastas

```
src/
  app/                       App Router (Next.js)
    (cockpit)/               grupo de rotas autenticadas do cockpit
      dashboard/ execucoes/ erros/ fontes/ api/ edital/[avisoId]/
    actions/                 server actions (auth)
    auth/callback/           callback OAuth
    login/                   tela de login
    proxy/[...path]/         proxy para Edge Functions
  components/
    cockpit/                 componentes de tela do cockpit
    ui/                      shadcn/ui
    auth/                    session-provider, google-button
  hooks/                     use-monitoring, use-substrato, use-admin, realtime
  lib/
    api/                     client, types, monitoring, substrato, admin
    supabase/                client, server, middleware, functions
    nav.ts status.ts pipeline.ts format.ts utils.ts
  middleware.ts              middleware Next (sessao)

supabase/
  functions/
    _shared/                 http, supabase, auth, audit, cors, env, embeddings,
                             vault, notify, types, file-processing, service-auth
    auth-google/ ingestao-config/ ingestao-execucoes/ ingestao-erros/
    ingestao-healthcheck/ fontes-credencial/ fontes-testar/
    substrato-aviso/ substrato-reindexar/
    v1-substrato-busca-semantica/ v1-lia-token/
  migrations/                01 extensions -> 10 busca_semantica (ordem por timestamp)

docs/                        artefatos do pipeline (PRD, SPEC, stories, design)
SPEC.md                      fonte de verdade da implementacao Fase 1
```

## Banco de dados (tabelas principais, schema `public`)

- `avisos` - substrato central, 1 registro por aviso Effecti. `effecti_id` UNIQUE = chave de deduplicacao. Guarda `conteudo_verbatim` e `payload_bruto` (jsonb completo).
- `aviso_arquivos` - arquivos de edital baixados/tratados (FK avisos, ON DELETE CASCADE).
- `aviso_chunks` - segmentos para embeddings, `embedding vector(1024)`, indice HNSW.
- `execucoes` - runs de sincronizacao (agendada/manual), Realtime habilitado.
- `erros_ingestao` - falhas por item/execucao (severidade, etapa, reprocesso).
- `fontes` + `config_ingestao` - fonte/credencial e frequencia/janela/filtros.
- `contas_autorizadas` - allowlist de acesso (email ou dominio).
- `audit_log` - audit trail generico (MOE), preenchido por triggers.

PKs UUID (`gen_random_uuid()`). RLS ativa (migration `..._rls.sql`). Triggers em `..._triggers.sql`. pg_cron em `..._pg_cron.sql`. Healthcheck e view derivada (`vw_healthcheck`).

## Convencoes encontradas

- **Edge Functions:** padrao `handler(req)` com `handleCorsPreflight`, `assertMethod`, `errorResponse`. Autorizacao SEMPRE antes de processar corpo. Endpoints `/v1` usam `authenticateV1` (API key de servico Vault OU sessao). Endpoints internos usam `requireAuthorizedUser` (Bearer + allowlist `contas_autorizadas`). Validacao server-side com zod (`_shared/validation`). Auditoria via `logSensitiveAction` sem vazar conteudo sensivel.
- **Seguranca:** defense in depth (borda + RLS). Segredos so como referencia no Vault, nunca texto pleno. service_role apenas server-side.
- **Frontend:** App Router com grupo `(cockpit)` autenticado. Navegacao travada por Design Lock (`src/lib/nav.ts`, 5 itens em 2 grupos). Hooks de dados via TanStack Query. Realtime para execucoes.
- **Design Lock:** `docs/.../design/manifest.json` travado (`locked: true`). Nenhuma tela, menu, componente ou estado fora do Design Lock deve ser implementado sem revisar o lock.
- **Comentarios:** cabecalho descritivo em arquivos com rastreabilidade a US/RF/RNF.

## Pontos de atencao para novas features

- O Design Lock restringe novas telas/itens de menu. Feature de UI precisa avaliar impacto no lock.
- Mudanca de dimensao de embedding fica isolada em `aviso_chunks`.
- US-06/US-09 (enriquecimento cognitivo via Claude) NAO sao da Fase 1 (apenas marcador de fronteira).
- Conteudo verbatim e payload bruto sao preservados integralmente: qualquer feature de escrita deve respeitar a integridade do substrato.
