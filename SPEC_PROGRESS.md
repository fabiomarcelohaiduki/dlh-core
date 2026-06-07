# SPEC_PROGRESS - DLH Core

## Status: 7/7 sprints concluidas
Ultima atualizacao: 2026-06-07T04:39:11.037Z

---

## Sprint 001 - Substrato de dados: schema, RLS, triggers e seed [CONCLUIDA]
- Extensoes e tabelas do substrato: Migracoes SQL que habilitam extensoes e criam todas as tabelas com PKs UUID e FKs conforme a secao 2.1 da SPEC.
- Indices e busca vetorial HNSW: Cria os indices de performance e o indice vetorial para busca semantica.
- RLS em todas as tabelas: Habilita Row Level Security em todas as tabelas com a policy unica do MVP baseada em contas_autorizadas.
- Triggers de auditoria, updated_at e pg_cron: Implementa o audit trail via triggers, atualizacao automatica de updated_at e o job agendado de coleta.
- View vw_healthcheck e seed inicial: Cria a view derivada de healthcheck e os registros semente para onboarding.

## Sprint 002 - Backend: fundacao compartilhada, auth e endpoints de leitura [CONCLUIDA]
- Modulos compartilhados _shared: Cria os helpers reutilizaveis de autenticacao/autorizacao, clientes Supabase e auditoria/observabilidade.
- Edge Function auth-google: Endpoint de autenticacao via Google OAuth com validacao de allowlist no callback.
- Endpoints de leitura de monitoramento: Endpoints GET de healthcheck, execucoes e erros consumidos pelo Dashboard, Execucoes e Erros.
- Endpoint de detalhe do edital: Endpoint GET que retorna o detalhe completo de um aviso para a tela de investigacao de erro.

## Sprint 003 - Backend: fontes/credenciais (Vault), config de ingestao e conector Effecti [CONCLUIDA]
- Credencial Effecti no Vault: Endpoints para gravar e testar a credencial Effecti sem nunca expor o segredo.
- Configuracao da ingestao: Endpoint para persistir frequencia, janela e filtros de modalidades/portais.
- Conector Effecti reutilizavel: Modulo de conector Effecti com paginacao, backoff e sync incremental, extensivel a novos conectores.

## Sprint 004 - Backend: pipeline de ingestao (coleta, tratamento, indexacao, persistencia) [CONCLUIDA]
- Orquestracao da coleta sob demanda: Endpoint que cria a execucao e dispara o pipeline assincrono com anti-duplo-disparo.
- Tratamento de arquivos de edital: Download e extracao verbatim de arquivos a partir do link, com fallback OCR.
- Indexacao por embeddings plugaveis: Geracao de chunks e embeddings via provider plugavel sem custo por token.
- Reprocesso por item: Endpoint que reprocessa um unico aviso (re-extracao e/ou reindexacao).
- Notificacao proativa de falha: Envio de e-mail transacional quando o healthcheck entra em Falha ou a sync falha por completo.

## Sprint 005 - Backend: busca semantica e API LLM-ready /v1 da Lia [CONCLUIDA]
- Busca semantica vetorial: Endpoint que gera embedding da query e retorna top-K por similaridade de cosseno.
- Token de servico da Lia e versionamento /v1: Autenticacao por API key de servico read-only distinta da sessao humana e da service_role.

## Sprint 006 - Frontend: setup, design system, shell/sidebar e login [CONCLUIDA]
- Scaffold Next.js + tokens visuais: Projeto Next.js 15 com Tailwind/shadcn em dark mode e tokens do Design Lock.
- Middleware de protecao e sessao: Protecao das rotas do cockpit com redirect para login.
- Shell do cockpit e sidebar: Route group (cockpit) com layout e navegacao persistente travada.
- Tela de login com Google: Tela /login com botao Entrar com Google e estados travados.

## Sprint 007 - Frontend: Dashboard e Execucoes (monitoramento + Realtime) [CONCLUIDA]
- Componentes de monitoramento reutilizaveis: stat-card, runs-table, erros-table e status-pill conforme estados travados.
- Tela Dashboard: Home do cockpit com KPIs, healthcheck, tabelas e coleta sob demanda.
- Tela Execucoes e Realtime: Lista de execucoes com progresso ao vivo e fallback de refetch.

## Sprint 008 - Frontend: Erros de ingestao e Detalhe do edital [CONCLUIDA]
- Tela Erros de ingestao: Lista filtravel de erros com navegacao para o edital.
- Tela Detalhe do edital: Inspecao do aviso com pipeline, verbatim/payload e reprocesso.

## Sprint 009 - Frontend: Administracao (Fontes, Ingestao) e API LLM-ready [CONCLUIDA]
- Tela Fontes e credenciais: Form de credencial Effecti mascarada e teste de conexao.
- Tela Configuracao da ingestao: Form de frequencia, janela, modalidades e portais com validacao.
- Console API LLM-ready (playground): Playground de busca semantica para validacao humana.

## Sprint 001 - Schema, RLS, RPC generalizada e seed da fonte Nomus [CONCLUIDA]
- Novas tabelas nomus_processos e memoria_chunks: Criar a tabela nomus_processos (snapshot vigente de processos com dedup por nomus_id) e a tabela memoria_chunks (indice semantico agnostico de origem que COEXISTE com aviso_chunks, sem migrar/alterar aviso_chunks). Ambas com RLS habilitada e policy unica is_conta_autorizada().
- Alteracoes nas tabelas config_ingestao, execucoes e erros_ingestao: Adicionar colunas novas conforme as secoes 2.1.2, 2.1.5 e 2.1.6, preservando o schema existente do Effecti e mantendo a compatibilidade (colunas legadas permanecem nullable).
- Generalizacao aditiva da RPC busca_semantica_chunks: Alterar a RPC busca_semantica_chunks para ser origem-aware (union entre aviso_chunks e memoria_chunks conforme escopo) com novo parametro opcional p_escopo, preservando integralmente os campos de retorno hoje consumidos pela Lia (mudanca estritamente ADITIVA - DD-03).
- Seed idempotente da fonte Nomus: Estender o seed existente (que so cria a fonte Effecti) para inserir, de forma idempotente, a fonte Nomus e sua config_ingestao com o mapa de recursos default. Nenhum novo agendador e criado.

## Sprint 002 - Conector Nomus e utilitarios compartilhados [CONCLUIDA]
- Tipo generico CollectedRecord: Criar supabase/functions/_shared/collected.ts com o tipo generico CollectedRecord, preservando o CollectedAviso existente do Effecti.
- hashConteudoCanonico: Criar supabase/functions/_shared/hash.ts com a funcao hashConteudoCanonico que produz um hash deterministico do conteudo textual canonico de um processo.
- NomusConnector (paginacao, contrato e duas empresas): Criar supabase/functions/_shared/nomus-connector.ts implementando a interface SourceConnector existente, coletando GET /rest/processos paginado e produzindo CollectedRecord, com auth Basic lida do Vault em runtime e header Basic nunca logado.
- Throttling, backoff e janela incremental (DD-02): Implementar o controle de throttling/retry do conector e a logica de janela incremental contemplando os dois caminhos do DD-02, governada por flag de config.

## Sprint 003 - Endpoints de credencial, teste de conexao e configuracao [CONCLUIDA]
- PUT fontes-credencial: Endpoint que grava a chave de integracao da fonte no Vault e persiste apenas a referencia em fontes.token_cifrado, nunca retornando o token.
- POST fontes-testar: Endpoint que le a chave do Vault em runtime e faz uma requisicao leve ao Nomus para validar credencial/endpoint, classificando a causa do resultado.
- GET/PUT ingestao-config: Endpoint para ler e gravar config_ingestao da fonte (janela, recursos ativos e tipos por recurso), governando coleta manual e agendada sem redeploy.

## Sprint 004 - Pipeline de coleta, coleta sob demanda e orquestrador [CONCLUIDA]
- Pipeline de persistencia e indexacao: Implementar/estender supabase/functions/pipeline.ts para persistir CollectedRecord em nomus_processos com dedup, decidir reindexacao por hash, indexar em memoria_chunks e isolar falhas por item.
- POST ingestao-coletar (single-flight + checkpoint em blocos): Endpoint que dispara coleta manual de fonte/recurso, cria execucao em_andamento e retorna imediatamente, respeitando single-flight e processando em blocos com checkpoint.
- POST ingestao-orquestrar (ciclo sequencial + retomada): Endpoint chamado pelo pg_cron que escolhe o proximo recurso pendente por ordem, avanca o checkpoint de uma execucao por tick, retoma blocos interrompidos e conclui execucoes.

## Sprint 005 - Busca semantica multi-origem para a Lia [CONCLUIDA]
- POST v1-substrato-busca-semantica com escopo: Endpoint /v1 que recebe query e escopo opcional, gera o embedding e chama busca_semantica_chunks origem-aware, retornando resultados com campos preservados + aditivos.

## Sprint 006 - Frontend: bloco Nomus na tela de Fontes [CONCLUIDA]
- FonteNomusBlock + CredForm (credencial e teste): Criar fonte-nomus-block.tsx na pagina /fontes contendo o formulario parametrizado de credencial e o teste de conexao, paritario com o bloco Effecti.
- CfgForm (recursos, tipos e janela): Criar cfg-form.tsx com toggles de recursos e tipos por recurso e edicao de janela_dias, consumindo useIngestaoConfig.
- ColetaButton + FonteSaude: Criar ColetaButton (dispara coleta manual) e FonteSaude (estado_conexao e ultima_coleta) no bloco Nomus.
- Hooks de API da fonte: Implementar os hooks TanStack Query consumidos pelo bloco Nomus, com tipos TS PascalCase batendo com os response bodies do backend.

## Sprint 007 - Frontend: execucoes e erros multi-origem com Realtime [CONCLUIDA]
- Execucoes com filtros, RunsTable e Realtime: Generalizar ExecucoesClient com OrigemFiltro e RecursoFiltro e atualizar RunsTable com colunas de origem/recurso e progresso/checkpoint ao vivo.
- Erros com filtros e ErrosTable: Generalizar ErrosClient com OrigemFiltro e RecursoFiltro e atualizar ErrosTable com colunas de origem/recurso/severidade/etapa.
