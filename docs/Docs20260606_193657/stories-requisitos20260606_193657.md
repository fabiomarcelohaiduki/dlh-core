# User Stories e Requisitos - Fonte Nomus (ERP) / Ingestao de Processos

> Projeto: DLH Core (substrato de memoria operacional + cockpit de ingestao).
> Feature: adicionar o ERP Nomus como nova fonte de dados, comecando pela ingestao dos Processos do tipo "Venda Governamental".
> Base: `discovery20260606_193657.md` + analise do codigo existente do repositorio `dlh-core`.
> Persona unica do MVP: usuario interno autorizado do nucleo DLH (perfil "interno", login Google), referido aqui como **operador do cockpit**. A IA **Lia** e consumidora read-only do substrato via API `/v1`.

---

## Sumario de escopo (fronteiras confirmadas no discovery)

DENTRO do escopo desta entrega:
- Conector Nomus com autenticacao Basic, paginacao, janela por data, backoff de throttling.
- Ingestao apenas do recurso `/processos` filtrando `tipo = "Venda Governamental"`, para as duas empresas (famaha e darlu).
- Persistencia em tabela propria do substrato (`nomus_processos`) com dedup por `nomus_id` e snapshot do estado vigente.
- Indexacao semantica do conteudo textual dos processos, com indice agnostico de origem e busca unificada com filtro de escopo.
- Coleta em blocos com checkpoint, orquestrador sequencial single-flight, e UI/observabilidade no cockpit com paridade ao Effecti.

FORA do escopo desta entrega (registrado, nao implementar agora):
- Campos personalizados do Nomus (write-only na API, nao retornados em nenhum GET).
- Anexos (do Nomus e do Effecti).
- Correlacao explicita processo <-> aviso.
- Escrita de volta no Nomus (cadastro de avisos/processos).
- Backfill historico (apenas o design deve acomodar; janela inicial = 7 dias).

---

## 1. User Stories

### Dominio A: Conexao e credencial da fonte Nomus

#### US-00 - Provisionar a fonte Nomus no substrato
**Como** desenvolvedor do DLH Core, **quero** que exista um registro da fonte `nomus` em `fontes` e sua `config_ingestao`, **para** que `getFonteByTipo("nomus")` resolva a fonte e os endpoints/coleta funcionem.
Referencia de codigo: seed `20260606120700_seed.sql` (hoje so cria a fonte Effecti); `getFonteByTipo()` lanca 404 quando a linha nao existe.
Criterios de aceite:
- Migracao/seed idempotente cria uma linha em `fontes` com `tipo = 'nomus'`, `endpoint_base` da instancia Nomus, `estado_conexao = 'nao_configurada'`, `token_cifrado = null`.
- A fonte Nomus recebe `ativa` e `ordem` para participar do ciclo do orquestrador.
- E criada a `config_ingestao` vinculada a fonte Nomus, com janela default de 7 dias e suporte a janela a partir de uma DATA ESPECIFICA (data inicial configuravel), nao apenas janela movel relativa.
- `getFonteByTipo("nomus")` passa a resolver a fonte sem 404.

#### US-01 - Cadastrar a credencial da fonte Nomus
**Como** operador do cockpit, **quero** cadastrar a chave de integracao REST do Nomus pela tela de Fontes, **para** habilitar a coleta sem editar codigo nem expor o segredo.
Referencia de codigo: padrao de `fontes-credencial/index.ts` (PUT, zod, `setFonteSecret`) e `_shared/vault.ts` (`setFonteSecret`, `getFonteByTipo`).
Criterios de aceite:
- A tela de Fontes exibe um bloco da fonte Nomus com campo para a chave de integracao.
- Ao salvar, a chave e gravada no Supabase Vault via RPC `set_fonte_secret` e `fontes.token_cifrado` guarda apenas a referencia.
- A chave nunca retorna ao cliente em nenhuma resposta nem aparece em log/auditoria.
- O endpoint exige sessao autorizada (`requireAuthorizedUser`) antes de processar o corpo.
- A acao e registrada em `audit_log` sem o valor do segredo (apenas referencia/fonte).
- Token vazio e rejeitado com erro de validacao (zod) e nada e gravado.

#### US-02 - Testar a conexao com o Nomus
**Como** operador do cockpit, **quero** testar a conexao com o Nomus, **para** confirmar que a credencial e o endpoint estao corretos antes de coletar.
Referencia de codigo: padrao de `fontes-testar/index.ts` e `EffectiConnector.testConnection` + `ConnectionTestError` em `_shared/effecti-connector.ts`.
Criterios de aceite:
- O teste faz uma requisicao leve ao Nomus (ex.: primeira pagina de `/rest/processos`) usando a chave do Vault lida em runtime.
- O resultado atualiza `fontes.estado_conexao` para `conectada`, `erro` ou `nao_configurada`.
- Falha 401 retorna mensagem de credencial invalida; 429 retorna mensagem de rate limit; timeout retorna mensagem de tempo excedido (causas distintas).
- A resposta inclui a latencia medida em milissegundos.
- Credencial ausente retorna estado `nao_configurada` com orientacao para cadastrar a chave antes de testar.
- A acao e auditada sem expor o segredo.

#### US-03 - Resolver a fonte por tipo parametrizado
**Como** desenvolvedor do DLH Core, **quero** que os endpoints de fonte resolvam a fonte pelo tipo informado (`effecti` ou `nomus`) em vez de fixar `effecti`, **para** que um segundo conector funcione sem duplicar endpoints.
Referencia de codigo: `getFonteByTipo()` em `_shared/vault.ts` (ja aceita parametro `tipo`, default `effecti`); paths fixos `/fontes/effecti/...` em `fontes-credencial` e `fontes-testar`.
Criterios de aceite:
- Os endpoints de credencial e teste aceitam o tipo da fonte como parametro (path ou corpo), nao mais fixo em `effecti`.
- `getFonteByTipo("nomus")` resolve a fonte Nomus a partir de `fontes.tipo = 'nomus'`.
- Chamar um tipo de fonte inexistente retorna 404 com mensagem clara.
- O comportamento existente do Effecti permanece inalterado (regressao zero nos fluxos atuais).

### Dominio B: Configuracao de recursos e tipos ativos

#### US-04 - Selecionar quais recursos do Nomus sincronizar
**Como** operador do cockpit, **quero** ligar/desligar quais recursos do Nomus sao ingeridos (processos agora; cobranca, propostas, pedidos, NFes, contas a receber no futuro), **para** controlar o escopo da coleta sem alterar codigo.
Referencia de codigo: modelo `config_ingestao` (analogo a `modalidades`/`portais`), endpoint `ingestao-config/index.ts`.
Criterios de aceite:
- O modelo persiste os recursos ativos numa coluna `jsonb` propria de `config_ingestao` (ex.: `recursos`), pois `modalidades`/`portais` (`text[] NOT NULL`) sao especificos do Effecti e nao comportam a estrutura recurso->tipos.
- A configuracao da fonte Nomus persiste a lista de recursos ativos.
- Nesta entrega, apenas o recurso `processos` vem ativo; os demais aparecem visiveis e desligados.
- A selecao persistida governa tanto a coleta manual quanto a agendada.
- Recursos desligados nao geram chamadas a API do Nomus.
- Alteracoes valem na proxima execucao, sem redeploy.

#### US-05 - Selecionar quais tipos por recurso sao ingeridos
**Como** operador do cockpit, **quero** escolher quais `tipo` dentro de `/processos` sao ingeridos (agora: "Venda Governamental"), **para** filtrar exatamente o subconjunto relevante sem trazer toda a base.
Referencia de codigo: filtro de allowlist no cliente do `EffectiConnector.collect` (Set de `modalidades`/`portais`).
Criterios de aceite:
- Os tipos ativos sao persistidos por recurso dentro da mesma estrutura `jsonb` (mapa recurso->tipos[]), nao em um `text[]` plano.
- A configuracao persiste, por recurso, a lista de tipos ativos.
- Nesta entrega, apenas `tipo = "Venda Governamental"` vem ativo para o recurso processos.
- O filtro por `tipo` e aplicado no cliente, sobre o array retornado pela API (a API nao filtra `tipo` por padrao confiavel para VG).
- Processos com `tipo` fora da allowlist sao descartados antes da persistencia.
- Lista de tipos vazia para um recurso ativo nao ingere nada daquele recurso (sem allowlist implicita de "todos").

### Dominio C: Conector e coleta da API Nomus

#### US-06 - Coletar processos paginados da API Nomus
**Como** operador do cockpit, **quero** que o conector Nomus percorra todas as paginas de `/rest/processos`, **para** que nenhum processo da janela seja perdido.
Referencia de codigo: padrao de paginacao do `EffectiConnector.collect` (loop de paginas ate esgotar); contrato `SourceConnector` e factory `createConnector` em `_shared/effecti-connector.ts`.
Criterios de aceite:
- O conector autentica com header `Authorization: Basic <chave>` e `Content-Type: application/json`.
- A paginacao usa o parametro `?pagina=N` incremental, comecando em 1.
- A listagem `GET /rest/processos?pagina=N` e tratada como array de processos; pagina vazia encerra a varredura.
- `createConnector("nomus", config)` retorna o conector Nomus sem alterar o caso `effecti`.
- Cada processo coletado preserva `id`, `tipo`, `pessoa`, `etapa`, `nome`, `reportador`, `responsavel`, `descricao`, `empresa` e o payload bruto integral.

#### US-07 - Respeitar o throttling do Nomus
**Como** desenvolvedor do DLH Core, **quero** que o conector respeite o rate limit do Nomus, **para** evitar bloqueios e perdas de coleta.
Referencia de codigo: `fetchWithBackoff` / `parseRetryAfter` / `computeBackoff` do `EffectiConnector`.
Criterios de aceite:
- Em HTTP 429, o conector aguarda o tempo indicado em `tempoAteLiberar` (segundos) antes de re-tentar.
- O conector processa em lotes com pausa entre lotes, com o TAMANHO DO LOTE e a DURACAO DA PAUSA parametrizados em constantes configuraveis (valores iniciais derivados do observado: ~14 chamadas / ~5s), de modo que o comportamento seja testavel e ajustavel sem alterar a logica.
- Erros transitorios 5xx usam backoff exponencial com teto; esgotado o numero de tentativas, a falha e registrada.
- 401 nao e re-tentado (credencial invalida) e gera erro classificado.

#### US-08 - Coletar processos das duas empresas
**Como** operador do cockpit, **quero** ingerir os processos das empresas famaha e darlu a partir da unica instancia Nomus, **para** ter a memoria operacional das duas empresas no substrato.
Referencia de codigo: decisao multi-empresa por campo `empresa` (uma fonte unica, sem multiplas instancias) em `getFonteByTipo`.
Criterios de aceite:
- CONFIRMADO: uma unica base + chave de integracao Nomus retorna os processos das DUAS empresas (famaha e darlu); o exemplo de URL por subdominio no discovery nao implica base/credencial por empresa. Mantem-se o modelo de fonte unica.
- A coleta usa uma unica fonte Nomus e uma unica chave de integracao.
- Cada processo persistido grava o campo `empresa` retornado pela API.
- O campo `empresa` discrimina a origem mas nao compoe a chave de deduplicacao.
- Processos de ambas as empresas aparecem no substrato apos a coleta.

### Dominio D: Persistencia no substrato

#### US-09 - Persistir processos em tabela propria com dedup
**Como** desenvolvedor do DLH Core, **quero** persistir os processos numa tabela `nomus_processos` com chave de dedup `nomus_id`, **para** nao forcar o dominio de processos dentro da tabela `avisos` (modelada por `effecti_id`).
Referencia de codigo: tabela `avisos` (`effecti_id UNIQUE`) em `20260606120100_tables.sql`; padrao de upsert `onConflict` em `runIncrementalSync`/`upsertBatch` e `persistAvisoBase` (`pipeline.ts`).
Criterios de aceite:
- Existe uma tabela `nomus_processos` com `nomus_id` UNIQUE NOT NULL como chave de deduplicacao.
- A tabela guarda os campos padrao expostos pelo GET (id, tipo, etapa, empresa, pessoa/cliente, descricao, nome, reportador, responsavel, datas) e o `payload_bruto` (jsonb integral).
- O upsert usa `onConflict: nomus_id`; reingestao do mesmo `nomus_id` sobrescreve com o estado vigente.
- A tabela tem PK UUID (`gen_random_uuid()`), RLS ativa no mesmo padrao das demais tabelas, e e auditada por trigger quando aplicavel.
- Campos personalizados do Nomus NAO sao persistidos (write-only, indisponiveis por GET).
- Anexos NAO sao persistidos nesta entrega.

#### US-10 - Manter o estado do processo atualizado
**Como** operador do cockpit, **quero** que reingerir um processo ja existente atualize seu estado (ex.: evolucao de `etapa`), **para** que o substrato reflita o snapshot vigente, nao apenas processos novos.
Referencia de codigo: controle `status_indexacao` e upsert idempotente em `pipeline.ts`/`embeddings.ts`.
Criterios de aceite:
- O upsert por `nomus_id` sobrescreve os campos com o estado atual a cada coleta.
- A reindexacao e decidida por comparacao de um HASH do conteudo textual canonico do processo (campos textuais definidos, sobretudo `descricao`, concatenados de forma deterministica). Se o hash mudar em relacao ao persistido, o processo e marcado para reindexacao (`status_indexacao` retorna a pendente/em_andamento e os chunks sao regenerados).
- Se o hash do conteudo textual canonico for igual ao persistido, nao ha reindexacao desnecessaria.
- O historico de evolucao de etapas NAO e persistido (apenas o estado vigente).

### Dominio E: Coleta em blocos com checkpoint e sync incremental

#### US-11 - Coletar em blocos com checkpoint e continuacao
**Como** desenvolvedor do DLH Core, **quero** que a coleta do Nomus rode em blocos com checkpoint persistido e se re-enfileire ate concluir, **para** ser robusta ao limite de tempo da Edge Function diante de uma base grande e com rate limit agressivo.
Referencia de codigo: `execucoes` (com `etapa_atual`, contadores) em `20260606120100_tables.sql`; padrao de execucao em `ingestao-coletar`/`pipeline.ts` (hoje materializa tudo em memoria, sem checkpoint).
Criterios de aceite:
- A tabela `execucoes` recebe, via migracao, as colunas necessarias ao checkpoint (ex.: `checkpoint` jsonb com pagina/cursor e contadores), pois hoje so possui `etapa_atual`, `total_processar`, `processados_sucesso`, `processados_erro` e `pendentes`, sem cursor de paginacao.
- Cada execucao da Edge Function processa um lote de paginas e persiste o progresso (pagina/cursor atual, contadores, estado) em `execucoes`.
- Ao atingir o limite do bloco, a continuacao e retomada pelo orquestrador via pg_cron existente (`ingestao-orquestrar`/`config_agendamento`), que no proximo tick avanca o checkpoint salvo, sem reprocessar paginas ja concluidas; NAO se cria fila nem mecanismo de auto-reinvocacao novo.
- O fluxo respeita o throttling do Nomus durante toda a continuacao.
- A execucao so e marcada como `concluida` quando todos os blocos da janela foram processados.
- Em falha de infraestrutura, a execucao reflete estado `erro` e o checkpoint permite diagnostico do ponto de parada.

#### US-12 - Sincronizar incrementalmente por data de ultima alteracao
**Como** operador do cockpit, **quero** que a janela incremental varra tanto processos novos quanto recem-alterados, **para** capturar atualizacoes de etapa, nao apenas criacoes.
Referencia de codigo: filtro de janela por data no `collect` do conector (analogo a `sinceDate`/`buildWindowBody`); janela default em `ingestao-coletar` (`DEFAULT_JANELA_DIAS = 7`).
Criterios de aceite:
- A janela inicial e de 7 dias.
- Quando a API expor um campo de ultima alteracao filtravel via `?query=campoData>yyyy-mm-ddTHH:mm:ss`, a janela usa esse campo (data de alteracao, nao de criacao).
- Quando o campo de ultima alteracao nao existir, o fallback re-varre periodicamente os processos nao finalizados (etapa nao terminal) alem da janela de novos.
- A janela e configuravel (mesma logica de `janela_dias` do `config_ingestao`).
- O design de blocos com checkpoint serve a janela incremental e prepara o caminho para backfill futuro sem reescrita.

### Dominio F: Indexacao semantica agnostica de origem

#### US-13 - Indexar o conteudo textual dos processos para busca semantica
**Como** Lia (consumidora do substrato), **quero** encontrar processos por similaridade textual, **para** recuperar memoria operacional relevante sobre vendas governamentais.
Referencia de codigo: `chunkText`/`generateAndStoreChunks` e provider plugavel (bge-m3, `vector(1024)`) em `_shared/embeddings.ts`; tabela `aviso_chunks` (HNSW) em `20260606120100_tables.sql`.
Criterios de aceite:
- O conteudo textual do processo (sobretudo `descricao`) e segmentado em chunks e indexado com embeddings.
- A indexacao reaproveita o provider plugavel existente (bge-m3, `vector(1024)`, indice HNSW `vector_cosine_ops`).
- Cada chunk carrega um discriminador de `origem`/`tipo` (ex.: `processo-venda-governamental`).
- O verbatim/payload integro do processo permanece preservado e nunca e mutado pela indexacao.
- A indexacao e idempotente: reindexar limpa os chunks antigos do processo antes de regravar.

#### US-14 - Indice de memoria agnostico de origem
**Como** desenvolvedor do DLH Core, **quero** que o indice semantico aceite chunks de qualquer recurso com discriminador de origem, **para** que novos recursos entrem so passando a ser indexados, sem nova RPC nem novo endpoint.
Referencia de codigo: `aviso_chunks` (hoje so de avisos) e RPC `busca_semantica_chunks` em `20260606121000_busca_semantica.sql`.
Criterios de aceite:
- Os chunks passam a viver num modelo agnostico de origem (tabela generica de chunks de memoria, ou union com discriminador) que convive com a busca de avisos ja em producao.
- A busca de avisos atualmente em producao continua funcionando sem regressao.
- Um chunk de processo so e retornado em consultas semanticamente proximas; nao polui consultas sobre editais.
- Adicionar um recurso futuro (ex.: cobranca) ao indice nao exige nova RPC nem novo endpoint de busca.

#### US-15 - Busca unificada com filtro de escopo
**Como** Lia (consumidora do substrato), **quero** buscar memoria por significado em todas as origens, com filtro opcional de escopo, **para** recuperar resultados marcados com sua origem (aviso, processo, etc.).
Referencia de codigo: endpoint `v1-substrato-busca-semantica/index.ts` e RPC `busca_semantica_chunks`.
Criterios de aceite:
- A busca retorna resultados de multiplas origens, cada um marcado com seu metadado de origem/tipo.
- A busca aceita um filtro de escopo OPCIONAL (tudo / so processos / so avisos / por tipo).
- Sem filtro de escopo, a busca e federada entre todas as origens indexadas.
- A autenticacao `/v1` existente (API key da Lia no Vault OU sessao do cockpit) e mantida.
- A generalizacao da RPC `busca_semantica_chunks` (hoje retorna `aviso_id` + `verbatim` com join obrigatorio a `avisos`) DEVE preservar a compatibilidade do contrato de resposta consumido pela Lia: o identificador de origem e ADITIVO (ex.: `origem` + `registro_id` generico), sem remover/renomear o campo hoje retornado, ou a resposta e versionada. O join passa a ser origem-aware (union/left join + `origem`), nao mais fixo em `avisos`.
- A correlacao explicita processo <-> aviso NAO e implementada (busca unificada nao implica vinculo entre registros).

### Dominio G: Orquestracao e agendamento

#### US-16 - Disparar coleta do Nomus sob demanda
**Como** operador do cockpit, **quero** disparar manualmente a coleta da fonte Nomus pela UI, **para** atualizar o substrato quando quiser.
Referencia de codigo: `ingestao-coletar/index.ts` (gatilho manual, anti-duplo-disparo) e `ColetaButton` em `execucoes-client.tsx`.
Criterios de aceite:
- O disparo generaliza o `ingestao-coletar` existente parametrizando `fonte` e `recurso` no `coletarSchema` e no handler (hoje fixo em `effecti`: `getFonteByTipo()` sem parametro e mensagem "credencial Effecti"), resolvendo `getFonteByTipo(fonte)` e com mensagem de erro de credencial generica por fonte; NAO se cria funcao nova por fonte.
- A UI permite disparar a coleta escolhendo a fonte/recurso (Nomus / processos) e respeita os tipos ativos configurados.
- O disparo manual cria uma execucao `em_andamento` e retorna imediatamente, com progresso refletido via Realtime de `execucoes`.
- O disparo respeita a trava single-flight: nao inicia se ja houver execucao em andamento.
- A acao e auditada em `audit_log`.

#### US-17 - Agendamento sequencial single-flight para multiplas fontes
**Como** operador do cockpit, **quero** que o agendamento automatico rode uma fonte/recurso por vez, sem coletas concorrentes, **para** preservar o rate limit do Nomus e evitar sobreposicao.
Referencia de codigo: `ingestao-orquestrar/index.ts` (relogio global, anti-sobreposicao, `runCycle` por ordem) e `config_agendamento` + `fontes.ativa`/`fontes.ordem` em `20260606130000_agendamento_global.sql`.
Criterios de aceite:
- Ha um unico orquestrador que escolhe o proximo recurso pendente e avanca seu checkpoint, passando ao proximo ao concluir.
- No maximo uma execucao ativa por vez (trava single-flight por estado em `execucoes`); um tique com execucao anterior em andamento nao inicia outra.
- Os incrementais de todas as fontes tem prioridade e rodam primeiro, na ordem cadastrada (`fontes.ordem`).
- O backfill (longo) roda em faixa de menor prioridade, preenchendo janelas ociosas, sem bloquear os incrementais.
- O agendamento automatico e OPCIONAL e reaproveita o mecanismo de pg_cron / `config_agendamento` ja existente, sem criar um agendador novo.

### Dominio H: UI e observabilidade no cockpit

#### US-18 - Bloco da fonte Nomus na tela de Fontes
**Como** operador do cockpit, **quero** ver e gerenciar a fonte Nomus na tela de Fontes, **para** cadastrar/testar credencial, selecionar recursos/tipos e disparar coleta.
Referencia de codigo: `fontes/page.tsx`, `fonte-effecti-block.tsx` (hoje lista "ERP Nomus" como fonte futura desabilitada), `cred-form.tsx`, `cfg-form.tsx`.
Criterios de aceite:
- A tela de Fontes passa a exibir um bloco ativo da fonte Nomus (sai da lista "Fontes futuras" desabilitadas).
- O bloco permite: cadastrar/testar a credencial, selecionar recursos ativos e tipos por recurso, e disparar coleta manual.
- Nesta entrega, vem ativo apenas o recurso processos + tipo "Venda Governamental"; os demais recursos aparecem visiveis e desligados.
- A inclusao das novas superficies passa pela revisao do Design Lock (`manifest.json locked:true`) sem quebrar as telas existentes travadas.
- As telas e itens de menu travados pelo Design Lock nao sao alterados sem destravar o lock.

#### US-19 - Monitorar execucoes e erros por origem e recurso
**Como** operador do cockpit, **quero** ver execucoes e erros discriminados e filtraveis por origem (Effecti x Nomus) e por recurso/tipo, **para** monitorar a fonte Nomus com a mesma paridade do Effecti.
Referencia de codigo: `execucoes-client.tsx`, `erros-client.tsx`, `runs-table.tsx`, `erros-table.tsx`, tabelas `execucoes` e `erros_ingestao`.
Criterios de aceite:
- A tabela `execucoes` recebe, via migracao, coluna de origem/fonte e de recurso/tipo (hoje a `execucoes` nao referencia `fontes` nem registra recurso), permitindo o filtro multi-origem.
- A tabela `erros_ingestao` recebe, via migracao, coluna de origem/recurso e uma referencia generica ao registro de origem (ex.: `registro_id` + `origem`), pois hoje so possui `aviso_id` (FK exclusiva a `avisos`), que nao serve a um erro de processo Nomus.
- As telas de execucoes e erros passam a discriminar e filtrar por origem (Effecti x Nomus) e por recurso/tipo.
- O historico de execucoes da fonte Nomus mostra estado, progresso/checkpoint, contadores e horarios.
- Os erros de ingestao da fonte Nomus aparecem por origem/recurso com severidade e etapa.
- O estado/saude da fonte Nomus (ultima coleta, sucesso/falha) e visivel, em paridade com o Effecti.
- A apresentacao reutiliza as tabelas `execucoes` e `erros_ingestao` existentes; o que muda e a generalizacao da apresentacao para multi-origem.

---

## 2. Requisitos Funcionais (RF)

### Dominio A: Conexao e credencial

- **RF-00** (US-00): O sistema DEVE provisionar, via migracao/seed idempotente, a fonte `nomus` em `fontes` (`tipo='nomus'`, `endpoint_base`, `estado_conexao='nao_configurada'`, `ativa`, `ordem`) e sua `config_ingestao` (janela default 7 dias e suporte a data inicial especifica), no padrao do seed do Effecti. Sem esse registro, `getFonteByTipo("nomus")` retorna 404.
- **RF-01** (US-01): O sistema DEVE gravar a chave de integracao do Nomus no Supabase Vault via RPC `set_fonte_secret`, persistindo apenas a referencia em `fontes.token_cifrado`. Integra-se a `_shared/vault.ts` (`setFonteSecret`).
- **RF-02** (US-01): O endpoint de credencial DEVE validar o corpo com zod (token nao-vazio) e exigir `requireAuthorizedUser` antes de processar o corpo, no padrao de `fontes-credencial/index.ts`.
- **RF-03** (US-02): O sistema DEVE testar a conexao com o Nomus lendo a chave do Vault em runtime e fazendo uma requisicao leve a `GET /rest/processos`, atualizando `fontes.estado_conexao` para `conectada`/`erro`/`nao_configurada`.
- **RF-04** (US-02): O teste de conexao DEVE classificar a causa da falha em `unauthorized` (401), `rate_limited` (429), `timeout` e `unknown`, retornando mensagem distinta por causa e a latencia em ms, no padrao de `ConnectionTestError`.
- **RF-05** (US-03): Os endpoints de credencial e teste DEVEM resolver a fonte pelo tipo informado (`nomus`), usando `getFonteByTipo(tipo)` (que ja aceita o parametro), sem path fixo `effecti`, preservando o comportamento atual do Effecti.

### Dominio B: Configuracao de recursos e tipos

- **RF-06** (US-04): O sistema DEVE persistir a lista de recursos ativos numa NOVA COLUNA `jsonb` de `config_ingestao` (ex.: `recursos`), com apenas `processos` ativo nesta entrega, pois `modalidades`/`portais` (`text[] NOT NULL`) sao especificos do Effecti; a config Nomus preenche `modalidades`/`portais` vazios (`'{}'`).
- **RF-07** (US-05): O sistema DEVE persistir, por recurso, a lista de tipos ativos DENTRO da mesma estrutura `jsonb` (mapa recurso->tipos[]), com apenas `Venda Governamental` ativo para o recurso `processos`, ja que um `text[]` plano nao representa tipos-por-recurso.
- **RF-08** (US-04, US-05): A selecao de recursos e tipos ativos DEVE governar tanto a coleta manual quanto a agendada, valendo na proxima execucao sem redeploy (padrao de `ingestao-config`).
- **RF-09** (US-05): O conector DEVE aplicar o filtro de `tipo` no cliente, sobre o array retornado pela API, descartando processos fora da allowlist antes da persistencia, no padrao de allowlist do `EffectiConnector.collect`.

### Dominio C: Conector e coleta

- **RF-10** (US-06): O conector Nomus DEVE autenticar com header `Authorization: Basic <chave>` + `Content-Type: application/json` e paginar `GET /rest/processos?pagina=N` de forma incremental a partir de 1, tratando a resposta como array.
- **RF-11** (US-06): A factory `createConnector` DEVE suportar o tipo `nomus` retornando o conector Nomus, sem alterar o caso `effecti`, mantendo o contrato `SourceConnector` desacoplado de `fontes.tipo`.
- **RF-12** (US-06): O contrato de dados do conector DEVE ser generalizado para acomodar um "registro coletado" de processo Nomus (campos padrao + payload bruto), ja que `CollectedAviso` nao comporta um processo. O Nomus usa contrato/segmento proprio ou um tipo generico de coleta.
- **RF-13** (US-07): O conector DEVE respeitar HTTP 429 aguardando `tempoAteLiberar` antes de re-tentar, processar em lotes com pausa entre lotes usando TAMANHO DE LOTE e PAUSA parametrizados em constantes configuraveis (defaults documentados: ~14 chamadas / ~5s), aplicar backoff exponencial com teto em 5xx, e nao re-tentar 401, no padrao de `fetchWithBackoff`/`parseRetryAfter`/`computeBackoff`.
- **RF-14** (US-08): A coleta DEVE usar uma unica fonte e chave Nomus e gravar o campo `empresa` de cada processo, ingerindo as empresas famaha e darlu, sem multiplas instancias de fonte. CONFIRMADO que uma unica base+chave retorna as duas empresas (o subdominio por empresa no exemplo da API nao exige fonte/credencial por empresa).

### Dominio D: Persistencia

- **RF-15** (US-09): O sistema DEVE criar a tabela `nomus_processos` com `nomus_id` UNIQUE NOT NULL (chave de dedup), PK UUID `gen_random_uuid()`, campos padrao do GET, `payload_bruto` jsonb integral e coluna de controle `status_indexacao`, no padrao de `avisos`.
- **RF-16** (US-09): A tabela `nomus_processos` DEVE ter RLS ativa na mesma policy do MVP (`is_conta_autorizada`) e ser coberta por triggers de auditoria/`updated_at` no padrao das demais tabelas.
- **RF-17** (US-09, US-10): A persistencia DEVE fazer upsert com `onConflict: nomus_id`, sobrescrevendo o estado vigente do processo a cada coleta, no padrao de `runIncrementalSync`/`persistAvisoBase` adaptado para `nomus_processos`.
- **RF-18** (US-09): O sistema NAO DEVE persistir campos personalizados (write-only, ausentes em qualquer GET) nem anexos nesta entrega.
- **RF-19** (US-10): Ao reingerir um processo, o sistema DEVE disparar reindexacao (regerar chunks/embeddings) quando o HASH do conteudo textual canonico (campos textuais definidos, sobretudo `descricao`, concatenados deterministicamente) mudar em relacao ao persistido, e evitar reindexacao quando o hash for igual, controlando por `status_indexacao`.

### Dominio E: Coleta em blocos e sync incremental

- **RF-20** (US-11): A coleta DEVE processar blocos de paginas por execucao da Edge Function, persistir o checkpoint (pagina/cursor, contadores, estado) em `execucoes`, INCLUINDO a migracao das colunas de checkpoint necessarias (a tabela atual nao possui coluna de pagina/cursor), e a continuacao DEVE ser retomada pelo orquestrador via pg_cron existente (`ingestao-orquestrar`/`config_agendamento`) ate concluir, sem fila nova nem auto-reinvocacao, sem reprocessar paginas concluidas.
- **RF-21** (US-11): A execucao so DEVE ser marcada `concluida` apos todos os blocos da janela; falha de infraestrutura DEVE refletir estado `erro` preservando o checkpoint para diagnostico.
- **RF-22** (US-12): A janela incremental DEVE usar o filtro de data da API (`?query=campoData>yyyy-mm-ddTHH:mm:ss`) operando sobre a data de ultima alteracao, com janela default de 7 dias configuravel via `janela_dias`.
- **RF-23** (US-12): Caso a API nao exponha um campo de ultima alteracao filtravel, o sistema DEVE aplicar o fallback de re-scan periodico dos processos nao finalizados (etapa nao terminal), alem da janela de novos. (Dependencia tecnica a confirmar na fase de spec.)

### Dominio F: Indexacao semantica

- **RF-24** (US-13): O sistema DEVE segmentar o conteudo textual do processo (sobretudo `descricao`) e gerar embeddings via provider plugavel existente (bge-m3, `vector(1024)`, HNSW `vector_cosine_ops`), de forma idempotente, no padrao de `chunkText`/`generateAndStoreChunks`.
- **RF-25** (US-14): O indice de chunks DEVE ser agnostico de origem, com discriminador `origem`/`tipo` por chunk, convivendo com a busca de avisos em producao sem regressao (migrar `aviso_chunks` para o modelo agnostico ou criar tabela generica que coexista).
- **RF-26** (US-15): O endpoint de busca semantica DEVE retornar resultados de multiplas origens marcados por origem/tipo e aceitar um filtro de escopo OPCIONAL (tudo / processos / avisos / por tipo), generalizando a RPC `busca_semantica_chunks` e o endpoint `v1-substrato-busca-semantica` sem novo endpoint por recurso, PRESERVANDO a compatibilidade do contrato de RESPOSTA para a Lia (campo de origem aditivo + `registro_id` generico; sem breaking no campo atualmente retornado) e tornando o join origem-aware em vez de fixo em `avisos`.
- **RF-27** (US-15): O sistema NAO DEVE criar vinculo explicito processo <-> aviso; a busca unificada e independente de correlacao entre registros.

### Dominio G: Orquestracao e agendamento

- **RF-28** (US-16): O sistema DEVE permitir disparo manual da coleta da fonte Nomus (recurso processos), criando execucao `em_andamento` com retorno imediato e progresso via Realtime de `execucoes`, GENERALIZANDO o `ingestao-coletar` existente (parametrizar `fonte` e `recurso` no `coletarSchema` e no handler, hoje fixos em `effecti`), sem criar funcao nova por fonte.
- **RF-29** (US-16, US-17): O sistema DEVE manter trava single-flight global: no maximo uma execucao ativa por vez; novo disparo (manual ou agendado) com execucao em andamento NAO inicia outra coleta, no padrao anti-sobreposicao de `ingestao-coletar`/`ingestao-orquestrar`.
- **RF-30** (US-17): O orquestrador DEVE percorrer as fontes/recursos ativos em ordem (`fontes.ordem`), coletando um por vez e avancando o checkpoint, reaproveitando `config_agendamento` e o pg_cron existentes, sem criar agendador novo.
- **RF-31** (US-17): O orquestrador DEVE priorizar os incrementais de todas as fontes (rodam primeiro) e rodar o backfill em faixa de menor prioridade, preenchendo janelas ociosas, com ordem/prioridade configuravel.

### Dominio H: UI e observabilidade

- **RF-32** (US-18): A tela de Fontes DEVE exibir um bloco ativo da fonte Nomus com cadastro/teste de credencial, selecao de recursos ativos e tipos por recurso, e disparo de coleta manual, no padrao de `fonte-effecti-block.tsx`/`cred-form.tsx`/`cfg-form.tsx`.
- **RF-33** (US-18): A inclusao das novas superficies de UI DEVE passar pela revisao/destrave do Design Lock (`manifest.json locked:true`) sem quebrar as telas existentes travadas (`src/lib/nav.ts`).
- **RF-34** (US-19): As telas de execucoes e erros DEVEM discriminar e filtrar por origem (Effecti x Nomus) e por recurso/tipo, reutilizando `execucoes` e `erros_ingestao` APOS migracao que adiciona, em ambas, as colunas de origem/fonte e recurso (hoje inexistentes) e, em `erros_ingestao`, uma referencia generica ao registro de origem em vez do `aviso_id` exclusivo a `avisos`, e os componentes `runs-table.tsx`/`erros-table.tsx`.
- **RF-35** (US-19): O cockpit DEVE expor o estado/saude da fonte Nomus (ultima coleta, sucesso/falha, progresso/checkpoint) em paridade com o Effecti, reaproveitando o padrao de observabilidade existente.

---

## 3. Requisitos Nao-Funcionais (RNF)

### Seguranca

- **RNF-01**: A chave de integracao do Nomus DEVE residir apenas como segredo no Supabase Vault (referencia em `fontes.token_cifrado`), nunca em texto pleno, nunca em `.env` de producao, nunca retornada ao cliente e nunca registrada em `audit_log` (apenas referencia/fonte). Defesa em profundidade: autorizacao na borda (`requireAuthorizedUser`) + RLS.
- **RNF-02**: Todo acesso de escrita ao substrato pela coleta DEVE usar `service_role` apenas server-side; a RPC de busca semantica permanece `SECURITY DEFINER` executavel so por `service_role`, com autorizacao garantida na borda (`authenticateV1`).
- **RNF-03**: A tabela `nomus_processos` e o indice de chunks DEVEM ter RLS ativa na policy `is_conta_autorizada`, em paridade com as demais tabelas do MVP.

### Confiabilidade

- **RNF-04**: A coleta DEVE ser robusta ao limite de tempo da Edge Function via blocos com checkpoint, com a retomada feita pelo orquestrador via pg_cron existente (sem fila nova nem auto-reinvocacao), garantindo retomada exata sem reprocessar paginas ja concluidas nem perder paginas pendentes.
- **RNF-05**: Falha isolada de um processo (tratamento/indexacao) NAO DEVE derrubar o lote: deve virar registro em `erros_ingestao` (severidade/etapa) usando a referencia generica de origem (nao o `aviso_id`, que so aponta para `avisos`) e a coleta continua, no padrao de isolamento de falha por item do `pipeline.ts`.
- **RNF-06**: O conector DEVE respeitar o `tempoAteLiberar` do HTTP 429 do Nomus e usar backoff exponencial com teto em 5xx, garantindo que nenhuma coleta concorrente rode em paralelo (single-flight), preservando o rate limit.
- **RNF-07**: A deduplicacao por `nomus_id` DEVE ser estavel e nao colidir entre as empresas; reingestao do mesmo `nomus_id` produz exatamente uma linha com o estado vigente.

### Performance

- **RNF-08**: A busca semantica multi-origem DEVE usar o indice HNSW (`vector_cosine_ops`) existente sobre vetores `vector(1024)`; o filtro de escopo opcional nao deve impedir o uso do indice vetorial.
- **RNF-09**: A geracao de embeddings da ingestao DEVE usar o provider self-hosted plugavel (bge-m3), com ZERO custo por token, sem nunca usar o modelo Claude na ingestao.
- **RNF-10**: O custo total do ciclo sequencial e aceito como a soma das fontes; janelas incrementais curtas (7 dias) DEVEM manter o custo baixo, e o backfill DEVE rodar em prioridade inferior para nao atrasar os incrementais (evitar starvation).

### Usabilidade

- **RNF-11**: O progresso da coleta Nomus DEVE refletir ao vivo via Realtime de `execucoes` (com fallback de poll), em paridade com o Effecti.
- **RNF-12**: As mensagens de erro de teste de conexao e de coleta DEVEM ser especificas por causa (credencial invalida, rate limit, timeout, indisponibilidade), no padrao de copy por causa ja adotado para o Effecti.
- **RNF-13**: As novas superficies de UI DEVEM respeitar o Design Lock vigente: nenhuma nova tela, item de menu, componente ou estado fora do lock sem revisao/destrave formal do `manifest.json`.

### Manutenibilidade e extensibilidade

- **RNF-14**: O design do conector e da configuracao DEVE acomodar recursos e tipos futuros (cobranca, propostas, pedidos, NFes, contas a receber) ligaveis por toggle, sem refatorar o conector a cada novo recurso/tipo.
- **RNF-15**: O modelo do substrato DEVE seguir uma tabela por recurso Nomus (`nomus_processos` agora; demais depois), com ingestao independente por recurso e dedup por id do recurso.
- **RNF-16**: A generalizacao do indice de chunks e da RPC/endpoint de busca DEVE permitir que novos recursos entrem apenas passando a ser indexados, sem nova RPC nem novo endpoint de busca.
- **RNF-17**: O reuso do Effecti limita-se ao PADRAO (paginacao + backoff + sync incremental + dedup), nao ao codigo literal: o sync e o contrato de dados DEVEM ser proprios do Nomus ou generalizados, ja que `runIncrementalSync`/`upsertBatch`/`CollectedAviso` sao acoplados ao dominio de avisos. A introducao do Nomus NAO DEVE causar regressao nos fluxos do Effecti.

---

## 4. Lacunas e dependencias a confirmar na proxima fase

> Itens que dependem de informacao externa ou de confirmacao tecnica; registrados para a fase seguinte tratar com o usuario, sem invencao aqui.

- **L-01** (RF-22/RF-23): Confirmar se o `GET /rest/processos` expoe um campo de ULTIMA ALTERACAO filtravel via `?query=campoData>...`. Se sim, a janela incremental usa esse campo; se nao, vale o fallback de re-scan dos processos nao finalizados.
- **L-02**: Detalhes operacionais da referencia externa "aiox" (auth, endpoints, tratamento de campos personalizados) nao estao no repositorio `dlh-core` e precisam ser fornecidos pelo usuario.
- **L-03** (RF-25): Decidir, na fase de design, entre migrar `aviso_chunks` para o modelo agnostico de origem ou criar tabela generica de chunks que coexista, preservando a busca de avisos ja em producao.
- **L-04** (RF-33): Escopo exato do destrave do Design Lock para as novas superficies da fonte Nomus a ser definido na fase de design.
- **L-05** (US-15/RF-26): Confirmar o contrato de resposta exato hoje consumido pela Lia em `v1-substrato-busca-semantica` (campos usados), para garantir que a generalizacao multi-origem seja aditiva e nao quebre o consumidor.
