# SPEC_PROGRESS - DLH Core

## Status: 13/13 sprints concluidas
Ultima atualizacao: 2026-06-12T20:03:29.684Z

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

## Sprint 001 - Schema do dominio Produtos - tabelas, constraints e indices (migration) [CONCLUIDA]
- 17 tabelas novas com colunas, FKs, CHECKs e indices: Criar em UMA migration timestampada (<timestamp>_produtos_schema.sql) todas as tabelas: produto_linhas, produto_linha_atributos, produtos, produto_skus, produto_imagens, insumos, insumo_precos, sku_composicao, sku_custo_aquisicao, parametros_calculo, parametro_regional, sku_precos_calculados, clientes_revenda, revenda_precos, cotacao_diretrizes, cotacao_regras, politica_participacao. Seguir EXATAMENTE os tipos, nullable, defaults, constraints e indices da secao 2.1 da SPEC.

## Sprint 003 - Motor de calculo deterministico e triggers de recalculo [CONCLUIDA]
- Funcao fn_recalcular_sku(sku_id) deterministica: Funcao que obtem o Custo Variavel do SKU (fabricado: soma quantidade*preco_vigente dos insumos da BOM + mao de obra = tempo_producao*taxa_horaria resolvida; comprado: custo_aquisicao vigente), resolve percentuais por COALESCE PRODUTO->LINHA->GLOBAL (impostos/frete/despesas/lucro/taxa_horaria) e o vetor regional por regiao, encadeia os percentuais com precisao interna de 4 casas e regrava as 10 linhas (5 regioes x CIF/FOB) em sku_precos_calculados preservando valor_anterior. Seta estado_calculo='vigente' ao concluir. Valor final arredondado a 2 casas ROUND_HALF_UP; custo_base mantem 4 casas.
- Tratamento de entradas faltantes (estado erro): Quando faltarem entradas essenciais, o SKU vai para estado_calculo='erro' sem gravar valor. Fabricado: composicao vazia OU algum insumo sem preco vigente. Comprado: sem custo de aquisicao vigente. Apos sanar a causa, novo recalculo retorna o SKU a 'vigente'.
- Triggers de recalculo sincrono: Criar os 7 triggers (secao 2.3) que invocam fn_recalcular_sku para os SKUs afetados DENTRO da propria transacao (sincrono e atomico): em sku_composicao (I/U/D), insumo_precos (I/U marca SKUs cuja BOM usa o insumo), parametros_calculo (I/U/D no escopo), parametro_regional (I/U/D), produto_skus AFTER UPDATE OF tempo_producao, sku_custo_aquisicao (I/U/D). Ao commitar a mudanca, os precos ja estao recalculados.

## Sprint 004 - Backend - Linhas, Atributos, Produtos e SKUs [CONCLUIDA]
- Edge Function produtos-linhas (Linhas + atributos): CRUD de produto_linhas (GET com filtro ?ativo=, POST nome unico, PUT incl. ativo, DELETE bloqueado 409 se houver produtos vinculados) e sub-rota /:id/atributos para gerenciar produto_linha_atributos (GET/POST/PUT/DELETE, chave unica por linha).
- Edge Function produtos-catalogo (Produtos): CRUD de produtos com validacao de atributos JSONB contra o schema da Linha: rejeita chave fora do schema E exige toda chave obrigatorio=true da Linha. GET /produtos?linha_id= lista; GET /produtos/:id retorna produto + atributos_schema + skus + imagens. DELETE bloqueado 409 se houver SKUs vinculados.
- CRUD de SKUs + reindex de diretriz_producao: Sub-rotas /produtos/:id/skus e /skus/:skuId para CRUD de produto_skus. POST valida codigo_sku unico e tipo_origem (fabricado default/comprado). Aceita diretriz_producao e tempo_producao opcionais. Ao salvar diretriz_producao, reindexa o chunk em memoria_chunks (origem='produto', tipo='produto-cotacao', registro_id=sku.id) via delete-then-insert idempotente; ao esvaziar diretriz_producao remove os chunks. Bloqueia incoerencias de tipo_origem (400).

## Sprint 005 - Backend - Insumos, Precos, Composicao e Custo de Aquisicao [CONCLUIDA]
- CRUD de insumos com bloqueio por uso: produtos-insumos: CRUD de insumos (categoria in MP/embalagem/insumo, unidade, ativo). DELETE bloqueado 409 se o insumo estiver referenciado em qualquer sku_composicao; insumo em uso so sai por ativo=false. Insumo inativo nao selecionavel em novas composicoes (validacao na borda).
- Precos de fornecedor + edicao em lote: Sub-rota /insumos/:id/precos (GET lista historico, POST cria nova faixa de vigencia preservando historico). Rota /insumo-precos/batch (PUT) edita ate 200 precos numa unica acao (400 acima). Escritas com logSensitiveAction. Os triggers da sprint 2 disparam recalculo automatico dos SKUs afetados.
- Composicao (BOM) e custo de aquisicao: produtos-composicao: CRUD de sku_composicao (/skus/:skuId/composicao e /composicao/:id) SO para SKU fabricado (400 se comprado), insumo inativo nao selecionavel, insumo ja na composicao 409. CRUD de sku_custo_aquisicao (/skus/:skuId/custo-aquisicao e /custo-aquisicao/:id) SO para SKU comprado (400 se fabricado), com historico de vigencia (GET vigente; ?historico=true) e logSensitiveAction.

## Sprint 006 - Backend - Parametros e Precos Calculados [CONCLUIDA]
- Parametros escalares e regionais: produtos-parametros: GET /parametros?nivel=&escopo_id= e PUT /parametros (upsert por nivel/escopo). GET/PUT /parametros-regional (vetor 5 regioes, override parcial). Escritas com logSensitiveAction. Os triggers disparam recalculo dos SKUs do escopo.
- Parametros resolvidos (efetivo vs herdado): GET /parametros-resolvidos?produto_id= retorna o valor EFETIVO de cada parametro escalar e de cada regiao para um Produto, indicando a origem (global/linha/produto). Resolucao PRODUTO->LINHA->GLOBAL.
- Precos calculados, apoio, recalculo e pendentes: produtos-precos: GET /skus/:skuId/precos (grid regiao x patamar + estado + apoio + custo_base). PUT /skus/:skuId/precos/apoio (grava apenas ifp/preco_concorrencia/custo_ideal, nunca valor/custo_base; null limpa). POST /skus/:skuId/recalcular (chama fn_recalcular_sku, fallback manual). GET /precos/pendentes (SKUs pendente/erro).

## Sprint 007 - Backend - Imagens (Storage) e Revenda [CONCLUIDA]
- Upload, listagem e remocao de imagens: produtos-imagens: POST multipart (file + produto_id?/sku_id? + ordem? + legenda?) grava no bucket privado 'produtos' via service_role e registra metadados. GET lista com signed URL temporaria (TTL 1h). DELETE remove objeto + metadado sem afetar o cadastro. Validacao na borda: max 5MB, MIME image/jpeg|png|webp, max 10 fotos por Produto e 10 por SKU.
- Clientes e precos de revenda: produtos-revenda: CRUD de clientes_revenda. Sub-rota /clientes-revenda/:id/precos (e /revenda-precos/:id) com HISTORICO de vigencia: GET retorna vigente por SKU (e historico com ?historico=true), POST cria nova faixa sem sobrescrever as anteriores. Estrutura SEPARADA do preco de licitacao.

## Sprint 008 - Backend - Criterios, Politica de Participacao e indexacao semantica [CONCLUIDA]
- Diretrizes textuais de cotacao com reindex: /cotacao-diretrizes?nivel=&escopo_id= CRUD por LINHA/PRODUTO. Ao salvar texto nao-vazio, reindexa em memoria_chunks (registro_id=cotacao_diretrizes.id). Ao deletar/esvaziar texto, remove os chunks.
- Regras estruturadas por atributo: /cotacao-regras?nivel=&escopo_id= CRUD de regras (tipo_regra in faixa/opcional/substituicao). Rejeita valor_min > valor_max com 400.
- Politica de participacao com reindex de diretriz_texto: /politica-participacao?nivel=&escopo_id= CRUD (participa in sim/nao/condicional + condicao + diretriz_texto + preferencia). Reindexa diretriz_texto em memoria_chunks (registro_id=politica_participacao.id); deletar/esvaziar remove os chunks.

## Sprint 009 - Backend - Consumo pela Lia (/v1) [CONCLUIDA]
- v1-produtos-consulta (3 blocos): GET /v1-produtos-consulta?sku_id= (ou ?produto_id=) retorna produto, sku (incl. tipo_origem), preco (CIF/FOB por regiao + estado_calculo), caracteristicas (atributos + comercial) e informacoes_cotacao (diretrizes + regras + politica). NAO expoe BOM, taxa horaria, percentuais nem lucro. Bloco PRECO nunca e ocultado pelo estado: sempre retorna ultimo valor + estado explicito; HTTP 200 mesmo em pendente/erro.
- v1-produtos-busca-semantica: POST /v1-produtos-busca-semantica recebe {query, limite?}, gera embedding bge-m3 vector(1024) e chama a RPC busca_semantica_chunks(p_embedding, p_limite, p_escopo='produto-cotacao'). query 1..2000 chars, limite default 10 max 50.

## Sprint 010 - Backend - Documentos PDF (MVP) [CONCLUIDA]
- Ficha tecnica e lista de precos de licitacao: POST /documentos/ficha-tecnica {produto_id} gera PDF de atributos + fotos (campos ausentes omitidos). POST /documentos/lista-precos-licitacao {sku_ids:[uuid]} gera PDF CIF/FOB por regiao dos SKUs, sinalizando pendentes de recalculo. Ambos retornam application/pdf streaming binario efemero (sem persistir no Storage).
- Composicao de custos do pregoeiro: POST /documentos/composicao-custos {sku_id} gera PDF da composicao de custos a partir da BOM + motor (valores so do motor). SO para SKU fabricado; SKU comprado retorna 422. Disponibiliza internamente a estrutura {itens, custos, percentuais, preco_final} para compor o PDF.

## Sprint 011 - Frontend - Camada de API, hooks, tipos e navegacao [CONCLUIDA]
- Tipos e modulos de API: Definir tipos em src/lib/api/types.ts (ProdutoLinha, LinhaAtributo, Produto, ProdutoDetalhe, ProdutoSku, ProdutoImagem, Insumo, InsumoPreco, SkuComposicaoItem, SkuCustoAquisicao, ParametrosCalculo, ParametroRegional, ParametrosResolvidos, PrecoCalculadoGrid, PrecoApoio, PrecoPendente, CotacaoDiretriz, CotacaoRegra, PoliticaParticipacao, ClienteRevenda, RevendaPreco) e modulos produtos.ts, insumos.ts, parametros.ts, criterios.ts, revenda.ts consumindo as Edge Functions via client/proxy existente. NAO inclui documentos.ts: a UI de exports em PDF (US-17/18/19) e Fase seguinte de UI (pos espinha dorsal) e exige nova revisao do Design Lock (SPEC 4.1) - fica fora deste plano.
- Hooks TanStack Query: Hooks em src/hooks/ com queryKeys namespaced e invalidacao em mutacao: use-linhas, use-linha-atributos, use-produtos, use-produto, use-skus, use-fotos, use-insumos, use-insumo-precos, use-composicao, use-custo-aquisicao, use-parametros, use-parametros-resolvidos, use-precos-calculados, use-apoio-precos (mutation), use-recalcular-sku (mutation), use-precos-pendentes, use-criterios, use-politica, use-revenda. NAO inclui use-documentos: a UI de exports em PDF e diferida para a fase seguinte (SPEC 4.1).
- Navegacao do grupo Produtos: Adicionar o grupo 'Produtos' no sidebar (src/lib/nav.ts) e atualizar design-contract.json com os itens de menu: Linhas & Produtos (/produtos), Insumos & Precos (/insumos), Parametros de custo (/parametros-custo), Revenda (/revenda). Padrao 1 item de menu = 1 tela.

## Sprint 012 - Frontend - Linhas, Produtos e detalhe denso [CONCLUIDA]
- Tela /produtos (master-detail) e atributos da Linha: Componentes linhas-table, linha-form (inline em card padrao cfg-form) e atributos-editor (pares chave-valor dinamicos definindo o conjunto de atributos da Linha). Drill-down Linha -> Produtos da Linha. Estados loading/error/empty.
- Detalhe denso do Produto + SKUs + fotos: produto-detalhe-client (/produtos/[produtoId]) com produto-form (atributos flexiveis renderizados do schema da Linha + campos comerciais), sub-secao de SKUs (sku-form com tipo_origem fabricado/comprado; diretriz e tempo so para fabricado) e fotos-uploader (upload/ordem/legenda, preview, estado sem fotos).
- Grid de preco calculado com estados: preco-regional-grid (5 regioes x CIF/FOB) com status-pill por estado (vigente=ok, pendente=warn, erro=err) e acao 'Recalcular' (use-recalcular-sku) quando pendente/erro. apoio-precos-form para captura manual de ifp/preco_concorrencia/custo_ideal; valor/custo_base read-only.

## Sprint 013 - Frontend - Insumos & Precos e Parametros de custo [CONCLUIDA]
- Tela /insumos com precos e composicao: insumos-table (categoria, unidade, ativo), insumo-precos-lote-form (edicao EM LOTE de precos, destaque do vigente), composicao-editor (BOM do SKU fabricado: seletor de insumo + quantidade/unidade) e custo-aquisicao-form (SKU comprado: fornecedor + custo + vigencia com historico).
- Tela /parametros-custo (3 niveis + regional): parametros-form (impostos, frete, despesas, lucro, taxa horaria, vetor regional) com badge de origem efetivo/herdado (GLOBAL/LINHA/PRODUTO) por valor e por regiao. Inclui grid regional x patamar com status-pill.
- Bloco de pendentes de recalculo: precos-pendentes-list (use-precos-pendentes) em /parametros-custo: lista SKUs com estado_calculo pendente/erro, cada item com status-pill e atalho para recalculo manual (use-recalcular-sku).

## Sprint 014 - Frontend - Revenda, criterios e politica [CONCLUIDA]
- Tela /revenda: clientes-revenda-table (clientes de revenda) e revenda-precos-form (tabela de precos por cliente/SKU com vigencia/historico). Canal separado do preco de licitacao.
- Criterios e regras de cotacao: criterios-form (diretrizes textuais por Linha/Produto) e regras-estruturadas-form (regras por atributo: faixa/opcional/substituicao) integrados ao detalhe do Produto e ao nivel Linha em /produtos.
- Politica de participacao: politica-participacao-form (flag participa sim/nao/condicional + condicao + diretriz_texto + preferencia) no detalhe do Produto e no nivel Linha.
