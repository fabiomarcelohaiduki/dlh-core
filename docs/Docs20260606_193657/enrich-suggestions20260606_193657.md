# Sugestoes de Enriquecimento - SPEC Fonte Nomus (ERP) / Ingestao de Processos

> Projeto: Nomus Processos (DLH Core).
> Arquivo de memoria persistente entre turnos do SPEC Enricher.
> SPEC analisada: C:\Users\Dell\dlh-core\SPEC.md
> Base de comparacao: PRD20260606_193657.md + stories-requisitos20260606_193657.md
> Legenda de status: [PENDENTE] -> aguardando decisao | [APROVADO] -> decidido, a aplicar | [APLICADO] -> ja editado na SPEC | [REJEITADO] -> descartado pelo usuario
> Gerado em: 2026-06-06

---

## A. Indexacao semantica / modelo de chunks

- **E1** [APLICADO] [INDEXACAO SEMANTICA] **INCONSISTENCIA CRITICA SPEC x PRD.** A SPEC (DD-01, secao 2.1.4 + pipeline 3.4.7 + RPC 2.3) decide GENERALIZAR a tabela existente `aviso_chunks` de forma aditiva (adiciona `origem`/`registro_id`, torna `aviso_id` nullable). O PRD APROVADO (D-02 e B-03) decide o OPOSTO: criar uma NOVA tabela `memoria_chunks` que COEXISTE com `aviso_chunks` intacta, gravando os chunks de processo em `memoria_chunks`. As duas abordagens sao mutuamente exclusivas e afetam migracao, pipeline, RPC `busca_semantica_chunks`, valores de escopo e risco de regressao. Precisa de decisao unica.
  Opcoes: a) Manter a decisao do PRD (nova tabela `memoria_chunks` coexistindo; `aviso_chunks` intacta) e CORRIGIR a SPEC para alinhar (pipeline grava em `memoria_chunks` com `origem`+`tipo`+`registro_id`). b) Manter a decisao da SPEC (alterar `aviso_chunks` aditivamente) e registrar que ela SUPERA o D-02 do PRD, justificando a mudanca. c) Outra abordagem hibrida a definir.
  Sugestao: opcao a) - o PRD foi aprovado com `memoria_chunks` coexistente, que tem risco ZERO de regressao na busca de avisos em producao (nao mexe na tabela viva) e e o que o backend B-03 ja referencia; alinhar a SPEC evita contradicao entre documentos aprovados.

- **E2** [APLICADO] [INDEXACAO SEMANTICA] O `hashConteudoCanonico` (3.4.6, RF-19) decide reindexacao, mas a SPEC diz apenas "campos textuais canonicos, sobretudo `descricao`". A lista EXATA de campos que compoem o hash nao esta definida; um dev teria que inventar.
  Opcoes: a) Apenas `descricao`. b) `descricao` + `nome` + `etapa` (campos que mudam de estado e impactam memoria). c) Concatenacao deterministica de `tipo`+`nome`+`descricao`+`etapa`+`pessoa`+`responsavel`.
  Sugestao: opcao b) - `etapa` e o que mais evolui (snapshot vigente, US-10) e deve disparar reindexacao; `pessoa`/`responsavel`/`tipo` raramente mudam e poluem o hash. Confirmar com o usuario o conjunto.

- **E3** [APLICADO] [INDEXACAO SEMANTICA] Conteudo textual que vira chunk (3.4.7, RF-24): a SPEC diz "sobretudo `descricao`" mas nao fixa quais campos compoem o texto efetivamente segmentado/embedado. Pode divergir do conjunto do hash (E2).
  Opcoes: a) Somente `descricao`. b) Cabecalho curto (`nome`/`tipo`/`empresa`) + corpo `descricao`, para enriquecer o contexto do embedding. c) Mesmo conjunto do hash (E2).
  Sugestao: opcao b) - prefixar `nome`/`tipo` ao `descricao` melhora a recuperacao semantica sem inflar o indice; alinhar depois de E2.

---

## B. Persistencia / schema (nomus_processos e erros_ingestao)

- **E4** [APLICADO] [PERSISTENCIA] INCONSISTENCIA de nomenclatura de colunas em `nomus_processos`. SPEC (2.1.3) usa `data_criacao`, `data_alteracao`, `hash_conteudo`. PRD (D-01) usa `data_inicial`, `data_final`, `data_ultima_alteracao`, `conteudo_hash`. Alem do nome, o PRD tem `data_final` que a SPEC nao tem. O PRD sinaliza que os nomes finais dependem do payload real do GET (L-01/dep DB).
  Opcoes: a) Adotar os nomes da SPEC (`data_criacao`/`data_alteracao`/`hash_conteudo`) e marcar PRD desatualizado. b) Adotar os nomes do PRD (`data_inicial`/`data_final`/`data_ultima_alteracao`/`conteudo_hash`). c) Definir nomes finais so apos amostra real do payload do GET `/rest/processos` (manter placeholders ate la).
  Sugestao: opcao c) com nota - como o proprio PRD condiciona os nomes ao payload real, registrar na SPEC que os nomes sao provisorios e congelar apos amostra; enquanto isso padronizar internamente para nao haver dois nomes para o mesmo campo. Decidir tambem se `data_final` e necessaria.

- **E5** [APLICADO] [PERSISTENCIA] INCONSISTENCIA no tipo/semantica de `erros_ingestao.registro_id`. SPEC 2.1.6 define `registro_id text` (ex.: `nomus_id`), mas a SPEC 2.5 (diagrama ER) e o PRD D-03/B-03 dizem `registro_id uuid = nomus_processos.id`. Contradicao inclusive interna a SPEC.
  Opcoes: a) `uuid` referenciando `nomus_processos.id` (alinha PRD D-03/B-03 e o diagrama ER). b) `text` armazenando `nomus_id` (alinha 2.1.6). c) `text` generico aceitando ambos conforme origem.
  Sugestao: opcao a) - `uuid = nomus_processos.id` e o que o pipeline B-03 grava e o que o diagrama ER assume; corrigir a 2.1.6 para `uuid`.

---

## C. Coleta em blocos / orquestracao / throttling

- **E6** [APLICADO] [COLETA EM BLOCOS] Tamanho do BLOCO (numero de paginas processadas por invocacao da Edge Function antes de salvar checkpoint e retornar) nao esta definido. O PRD (dep de Backend) lista isso explicitamente como "a calibrar na spec". Sem isso o dev inventa K e o orcamento de tempo da Edge Function.
  Opcoes: a) Bloco fixo por numero de paginas (ex.: K=10 paginas/invocacao). b) Bloco por orcamento de tempo (ex.: ~50s de wall-clock, respeitando o limite da Edge Function), parando no fim do lote corrente. c) Combinacao: limita por tempo OU por K paginas, o que vier primeiro, com K e tempo em constantes configuraveis (.env).
  Sugestao: opcao c) - dado o throttling agressivo (~14 chamadas + ~5s de pausa) e a base ~720+ paginas, limitar por tempo evita timeout e K como teto de seguranca; expor `NOMUS_BLOCO_MAX_PAGINAS` e `NOMUS_BLOCO_MAX_MS` no .env.

- **E7** [APLICADO] [THROTTLING] Numero MAXIMO de tentativas do backoff exponencial em 5xx nao esta definido (a SPEC/RF-13 cita "teto" e "esgotado o numero de tentativas" sem o valor). Idem teto maximo do delay.
  Opcoes: a) 3 tentativas, teto de delay 30s. b) 5 tentativas, teto de delay 60s. c) Configuravel via .env (`NOMUS_MAX_RETRIES`, `NOMUS_BACKOFF_TETO_MS`).
  Sugestao: opcao c) com defaults da (b) - parametrizar para calibracao sem redeploy, mantendo o padrao do conector Effecti.

- **E8** [APLICADO] [ORQUESTRACAO] Recuperacao de execucao em estado `erro` (fluxo alternativo). A SPEC preserva o `checkpoint` em falha de infra (RF-21) mas nao define QUEM retoma: o `ingestao-orquestrar` retoma automaticamente a execucao em `erro` no proximo tick, ou exige novo disparo manual do operador?
  Opcoes: a) Orquestrador retoma automaticamente execucoes `erro` com checkpoint valido (auto-heal), respeitando single-flight. b) Execucao `erro` so e retomada por novo disparo manual do operador (a UI oferece "Retomar/Re-tentar"). c) Auto-retoma com limite de N tentativas; apos isso, requer acao manual.
  Sugestao: opcao c) - auto-retoma resiliente porem com teto para nao entrar em loop de falha permanente; expor acao manual na UI quando o teto for atingido.

- **E9** [APLICADO] [SYNC INCREMENTAL] Fallback do DD-02/RF-23 re-varre "processos com `etapa` nao terminal", mas a SPEC nao lista QUAIS etapas sao terminais vs nao-terminais. O dev nao tem como classificar sem inventar.
  Opcoes: a) Lista de etapas terminais fixa no codigo (ex.: "Concluido", "Cancelado", "Perdido") - todas as demais sao nao-terminais. b) Coluna/config de etapas terminais por recurso em `config_ingestao.recursos` (configuravel sem redeploy). c) Definir apos amostra real dos valores de `etapa` retornados pela API.
  Sugestao: opcao b) apos (c) - levantar os valores reais de `etapa` na amostra e persistir a allowlist de etapas terminais em config (extensivel a recursos futuros). Confirmar os valores com o usuario.

- **E10** [APLICADO] [SYNC INCREMENTAL] Comportamento e exposicao de `config_ingestao.data_inicial`. A SPEC diz "janela default 7 dias ou `data_inicial`" (3.4.1) mas nao define a precedencia (se `data_inicial` preenchida, sobrepoe `janela_dias`? coleta de `data_inicial` ate agora?) nem se o campo e editavel na UI - o `cfg-form-nomus` (F-01/4.2) so menciona "janela de dias".
  Opcoes: a) `data_inicial` sobrepoe `janela_dias` quando preenchida (coleta de data_inicial ate now); editavel na UI. b) `data_inicial` apenas para seed/backfill futuro, NAO editavel na UI nesta entrega (somente `janela_dias` na UI). c) Ambos coexistem com regra explicita de precedencia documentada.
  Sugestao: opcao b) - manter a UI simples nesta entrega (so `janela_dias`), `data_inicial` reservada para backfill futuro via seed/migracao; documentar a precedencia para quando for ativada.

---

## D. Busca semantica / API da Lia

- **E11** [APLICADO] [BUSCA SEMANTICA] Limites do parametro `limite`/`topK` (3.2.6) nao definidos: default, minimo e maximo (clamp). O PRD B-05 cita "clamp existente" sem o valor. Tambem nao ha limite de tamanho da `query`.
  Opcoes: a) default 10, min 1, max 50; query max 2000 chars. b) default 10, min 1, max 100; query max 8000 chars. c) Reusar exatamente o clamp ja existente no endpoint atual (confirmar valor no codigo).
  Sugestao: opcao c) - reaproveitar o clamp ja vigente para a Lia preserva o contrato; se inexistente, adotar (a). Confirmar no codigo (depende de L-05).

---

## E. UI / observabilidade / copy

- **E12** [APLICADO] [OBSERVABILIDADE UI] Paginacao e ordenacao default das tabelas `/execucoes` e `/erros` nao estao definidas. Com base grande e coletas frequentes, as listas crescem; o dev inventaria page size e ordenacao.
  Opcoes: a) Paginacao por offset (page size 25), ordenacao por `iniciada_em`/`created_at` desc. b) Scroll infinito por cursor, ordenacao desc. c) Limite fixo "ultimas N" (ex.: 50) sem paginacao nesta entrega, ordenacao desc.
  Sugestao: opcao a) - offset com page size 25 e o padrao mais simples e em paridade com o Effecti; ordenar por data desc (mais recentes primeiro).

- **E13** [APLICADO] [COPY/TEXTOS] Copy exata pendente: (i) mensagens por causa no teste de conexao e na coleta (`unauthorized`/`rate_limited`/`timeout`/`unknown`); (ii) toasts de sucesso (credencial salva, conexao OK, coleta iniciada); (iii) textos de estado vazio; (iv) labels de exibicao dos recursos futuros desabilitados (`cobranca`, `propostas`, `pedidos`, `nfes`, `contas_a_receber`). O PRD (dep Frontend) lista esses labels como pendentes.
  Opcoes: a) Definir todas as strings agora (lista fechada de copy). b) Reusar 1:1 a copy ja adotada no bloco Effecti (espelhar) e so criar labels novos para os recursos. c) Definir apenas labels dos recursos agora; mensagens de erro/sucesso herdam o padrao Effecti.
  Sugestao: opcao b) - espelhar a copy do Effecti garante paridade e consistencia (RNF-12); criar so os labels dos recursos novos (sugestao: "Cobranca", "Propostas", "Pedidos", "NF-es", "Contas a Receber").

- **E14** [APLICADO] [RESPONSIVIDADE] A SPEC declara "sem mobile" (1.3), mas nao define o comportamento do cockpit em larguras reduzidas / breakpoints (tabelas largas de execucoes/erros, bloco de fonte). Item de menor prioridade por ser cockpit interno desktop.
  Opcoes: a) Desktop-only assumido; sem garantia de responsividade (overflow horizontal com scroll nas tabelas via `.tbl-wrap`). b) Garantir layout fluido ate ~768px reusando os utilitarios Tailwind existentes. c) Fora de escopo explicito nesta entrega.
  Sugestao: opcao a) - assumir desktop-only e confiar no `.tbl-wrap` (scroll horizontal) ja existente; registrar explicitamente para nao ficar implicito.

---

## F. Ambiguidade de contrato HTTP

- **E15** [APLICADO] [COLETA SOB DEMANDA] Ambiguidade de status code no single-flight de `ingestao-coletar` (3.2.4). A tabela lista status `202` (aceito) E `409` (ja em andamento), mas o Response Body mostra `{ ...estado: "em_andamento", ja_em_andamento: true }`. Nao esta claro se "ja em andamento" retorna 202 (com flag) ou 409.
  Opcoes: a) 409 com corpo `{ execucao_id, estado, ja_em_andamento: true }` (semantica HTTP de conflito). b) 202 sempre, distinguindo apenas pela flag `ja_em_andamento` no corpo (UI trata pelo flag). c) 200 com flag.
  Sugestao: opcao a) - 409 e semanticamente correto para conflito de single-flight e ja e o status declarado na propria SPEC para esse caso; a UI exibe "ja existe uma coleta em andamento".

---

## Resumo
- Total de itens: 15 (E1..E15)
- Inconsistencias SPEC x PRD: E1, E4, E5 (+ E15 ambiguidade interna)
- Lacunas que forcam invencao: E2, E3, E6, E7, E8, E9, E10, E11, E12, E13
- Menor prioridade: E14
