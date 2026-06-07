# Briefing inicial — DLH Core

Voce esta iniciando uma sessao no Open Design embarcada no LionClaw (pipeline Development V2).

## Hierarquia de prioridade

Siga esta ordem quando houver conflito:

1. **Schema do `lionclaw-design-contract` e Design Lock** — campos obrigatorios, JSON valido e rastreabilidade vencem tudo.
2. **Cobertura das user stories aprovadas** — nenhuma tela, menu, entidade, permissao ou acao pode existir sem userStoryIds ou delta explicito.
3. **Briefing de produto e mapa de telas** — organize o produto em telas reais e estados funcionais.
4. **Skill de Frontend de Alto Nivel** — melhora a qualidade visual, mas nao pode ampliar escopo nem quebrar contrato.

## Exigencias obrigatorias

- Gerar design **high-fidelity**, nao wireframe.
- Nao inventar telas, fluxos, permissoes ou entidades fora das user stories listadas abaixo.
- Gerar artifact HTML standalone (single file ou exportavel por este OD), clicavel localmente.
- Embutir o bloco `<script type="application/json" id="lionclaw-design-contract">{...}</script>` no artifact final.
- Responda e nomeie artefatos em portugues brasileiro (locale=pt-BR), salvo se o projeto configurar outro idioma.
- **Use `save_artifact` APENAS para HTML.** Markdown, prose, racional de design, decisoes ou explicacoes vao no chat — nao tente salvar como artifact (sera rejeitado pelo validator do OD).
- **NAO abra questionario, formulario de briefing, question-form ou discovery form.** Voce ja tem material suficiente. Se algo visual faltar, assuma defaults coerentes e continue.

## Defaults quando o briefing visual estiver incompleto

- Superficie principal: desktop web responsivo.
- Avaliador do prototipo: fundador tecnico / dev solo que precisa validar se o produto e implementavel.
- Tom visual: modern minimal + tech utilitario, com acabamento refinado e sem cara de landing page.
- Contexto de marca: escolha uma direcao propria, coerente com o produto e com a skill; nao peça brand spec, referencia visual ou screenshot.
- Escopo desejado: cobrir as user stories aprovadas no menor conjunto de telas funcionais.
- Restricoes adicionais: se algo estiver incerto, registre em `deltas[]` no contract e siga. So pare para perguntar se for impossivel gerar HTML valido.

## Formato OBRIGATORIO do artifact: SPA multi-tela navegavel

**Este e o ponto mais importante do briefing. Leia duas vezes.**

O artifact entregue NAO eh uma "gallery de telas", showcase, landing page, case-study, pitch deck, scroll-narrative, "design portfolio" ou pagina unica com sections empilhadas mostrando como cada tela ficaria. Esses formatos sao **proibidos**.

O artifact eh uma **Single Page Application clicavel** onde:

1. **Cada tela do contract (`screens[]`) = uma `<section>` HTML separada** com `id` igual ao `screens[].id` e atributo `hidden` por padrao.
2. **Apenas uma tela fica visivel por vez.** A troca de tela acontece por mudanca de `location.hash` (router minimo em JS inline) ou toggling de `hidden` em resposta a eventos reais (submit de `<form>`, click em botao de nav, etc.).
3. **Login com `<form>` real** (`<input type="password">`, etc.) que ao submit muda pra tela principal. Nada de "mockup decorativo" de login na mesma viewport da tela principal.
4. **Estados visuais** (idle / escutando / processando / falando, ou equivalente) sao **estados da mesma tela** alternados por interacao real (click no botao do microfone, etc.) — NAO sao 5 cards lado-a-lado mostrando "como ficaria cada estado".
5. **`navigation.primary[]` do contract precisa estar funcional**: os items listados ali precisam existir como elementos clicaveis no DOM que mudam de tela quando clicados.
6. Copy editorial / parrafos descritivos / "pitch" do produto / explicacoes sobre o design **NAO entram no HTML** — vao na resposta do chat.

### Regra anti-tela-empilhada [CRITICO]

Um `index.html` unico esta correto. O que e proibido e renderizar as telas uma abaixo da outra como uma pagina longa.

- Inclua CSS obrigatorio: `[hidden] { display: none !important; }`.
- No DOM inicial, as `section` de telas podem existir, mas **somente uma** pode estar visivel.
- A tela de login nao pode ficar acima do app shell nem aparecer junto com telas internas ao rolar a pagina.
- Telas internas como dashboard, crons, integracoes, runs, logs, cobranca e auditoria devem iniciar com `hidden`.
- O submit do login deve esconder `#login` e mostrar a primeira tela interna via JS real.
- Cliques na navegacao devem alternar `hidden` entre as sections, nao apenas rolar para anchors empilhadas.
- Se uma pessoa conseguir rolar e ver login + outra tela sem submeter login ou clicar na navegacao, o artifact esta invalido. Corrija antes de usar `save_artifact`.

Teste mental antes de salvar: "Um usuario abre o HTML, ve a tela 1 sozinha (login). Submete o form. Some a tela 1, aparece a tela 2 (principal). Clica no botao do mic. A orb muda de estado. Para de aparecer a tela 1 mesmo se rolar a pagina." Se qualquer parte desse teste falha (ex: ver login e main ao mesmo tempo ao rolar), o artifact esta errado.

## Briefing de produto e cobertura

Use o mapa abaixo para planejar telas antes de desenhar. Ele existe para evitar que o HTML vire uma copia literal das user stories.

### Mapa compacto de user stories

- US-00: US00 — Estrutura e navegação do cockpit Como usuário interno do núcleo DLH, quero um cockpit com navegação clara entre Monitoramento e Administração da ingestão, para operar e resolver problemas da coleta sem me perder. Padrão de interface: layout com navegação persistente (menu lateral/topo) + área de conteúdo; com tela de login "Entrar com Google" (acesso aute
- US-21: US21 — Autenticação de acesso ao cockpit Como usuário interno do núcleo DLH, quero acessar o cockpit fazendo login com a minha conta Google, para proteger as operações e configurações do sistema sem gerenciar senha própria. Padrão de interface: tela de login com botão "Entrar com Google"; sessão autenticada; ação de logout. Critérios de aceite:  O acesso ao co
- US-02: US02 — Coleta automática de avisos (via API) Como usuário interno do núcleo DLH, quero que o sistema colete os avisos do portal Effecti via API automaticamente, para não depender de ninguém acessar o portal manualmente. Padrão de interface: processo de background (sem tela própria); resultado visível no Monitoramento. Critérios de aceite:  O conector consome o
- US-19: US19).  Cada aviso coletado é persistido no substrato Supabase após passar pelo pipeline de tratamento.  Todos os campos do aviso retornados pela API Effecti são persistidos integralmente no substrato, incluindo o payload bruto completo retornado pela API (além dos campos já modelados), sem descartar campos — alinhado ao princípio MOE de preservação do fato literal.
- US-03: US03 — Agendamento e janela de ingestão da coleta Como usuário interno do núcleo DLH, quero configurar a frequência da coleta e a janela de dias dos avisos a ingerir, para alinhar a sincronização à rotina e trazer apenas avisos recentes e relevantes. Padrão de interface: formulário de configuração na Administração da ingestão (frequência/horário + janela de dias
- US-04: US04 — Execução de coleta sob demanda Como usuário interno do núcleo DLH, quero disparar a coleta do Effecti manualmente, para buscar novidades imediatamente sem esperar o próximo agendamento. Padrão de interface: ação/botão na tela de administração da ingestão. Critérios de aceite:  Existe ação que dispara a coleta sob demanda independentemente do agendamento
- US-05: US05 — Sincronização incremental Como usuário interno do núcleo DLH, quero que a coleta traga apenas o que mudou desde a última sincronização, para evitar reprocessamento e duplicidade de editais. Padrão de interface: processo de background; estado refletido no monitoramento. Critérios de aceite:  O conector identifica e processa apenas itens novos ou alterado
- US-07: US07 — Administração de fontes e credenciais Como usuário interno do núcleo DLH, quero gerenciar as fontes de ingestão e suas credenciais, para manter a coleta funcionando sem editar código. Padrão de interface: tela de administração (lista de fontes + formulário de credenciais). Critérios de aceite:  É possível visualizar a fonte Effecti e o estado de sua con
- US-20: US20 — Seleção de modalidades e portais a ingerir Como usuário interno do núcleo DLH, quero selecionar quais modalidades de licitação e quais portais o sistema deve ingerir, para trazer apenas o que é relevante para a operação e reduzir ruído. Padrão de interface: formulário de filtros na Administração da ingestão. Critérios de aceite:  É possível selecionar u
- US-08: US08 — Indexação para busca e preservação verbatim na ingestão Como Lia (IA), quero que cada aviso e o conteúdo do seu edital sejam preservados (verbatim) e indexados para busca semântica já na ingestão, para localizar o edital relevante sem depender do enriquecimento cognitivo, que é feito sob demanda na análise (Fase 2). Padrão de interface: processo de backgr
- US-10: US10 — Persistência da memória operacional Como usuário interno do núcleo DLH, quero que os editais coletados fiquem persistidos no substrato, para que o conhecimento não dependa da cabeça de ninguém. Padrão de interface: processo de background; consumo pela Lia via API e, para humanos, apenas no detalhe acessado na investigação de erro. Critérios de aceite:
- US-14: US14 — Detalhe de um edital na investigação de erro Como usuário interno do núcleo DLH, quero abrir o detalhe de um edital específico ao investigar um erro de ingestão, para entender o que falhou naquele item. Padrão de interface: tela de detalhe acessada a partir de um erro no Monitoramento (não há lista nem busca livre de editais). Critérios de aceite:  O de
- US-15: US15 — Status e healthcheck da ingestão Como usuário interno do núcleo DLH, quero ver o status das execuções e a saúde da ingestão, para saber se a coleta está funcionando sem investigar logs. Padrão de interface: dashboard de monitoramento. Critérios de aceite:  O dashboard exibe o status das execuções de sincronização (concluída, em andamento, com erro).  O
- US-16: US16 — Visibilidade de erros de coleta Como usuário interno do núcleo DLH, quero ver os erros ocorridos na coleta, no tratamento dos arquivos de edital e na indexação, para agir sobre o que falhou. Padrão de interface: lista de erros no dashboard de monitoramento. Critérios de aceite:  Erros de coleta, de tratamento de arquivos de edital e de indexação/embeddi
- US-17: US17 — Consumo do substrato pela Lia via API LLMready Como Lia (IA), quero consumir o substrato via API/MCP LLMready, para obter contexto pronto sem executar SQL bruto. Padrão de interface: API/MCP (sem tela). Critérios de aceite:  A API/MCP expõe os itens do substrato como contexto consumível pela Lia — conteúdo literal (verbatim) e metadados estruturados —
- US-18: US18 — Busca semântica via API LLMready Como Lia (IA), quero consultar o substrato por busca semântica via API, para recuperar editais relevantes ao contexto de uma decisão. Padrão de interface: API/MCP (sem tela). Critérios de aceite:  A API/MCP aceita consulta semântica e retorna itens por relevância usando embeddings.   2. Requisitos Funcionais
- US-06: US06 e os RF08/RF09 (versionamento de editais) foram removidos. O histórico/audit trail de alterações permanece como propriedade da MOE no substrato (US10/RF20).  Enriquecimento cognitivo sob demanda (Fase 2): decisão do fundador — na Fase 1 a ingestão não executa o enriquecimento via Claude (camposchave, resumo, classificação MOE). O conteúdo é preservado (verba
- US-09: US09 (distinção fato/hipótese via MOE) e os RF13/RF15/RF16/RF17 foram movidos para a Fase 2.  Editais extensos e fidelidade do conteúdo: o conteúdo literal extraído (em especial a tabela de descrição dos itens) é persistido íntegro e idêntico (verbatim), nunca resumido. Na Fase 1, a segmentação/chunking serve apenas à geração de embeddings, sem alterar o

## Design Plan aprovado antes do Open Design

Este e o blueprint de produto para o artifact visual. O schema do design-contract e o Design Lock continuam tendo prioridade maxima.
Plano deterministico gerado pelo LionClaw; validacao deterministica: aprovada.


Telas planejadas:
- login (Login) — Autenticar usuario antes de acessar dados protegidos. — stories: US-00
- principal (Principal) — Executar as principais tarefas do produto usando dados das stories aprovadas. — stories: US-00, US-02, US-03, US-04, US-05, US-06, US-07, US-08, US-09, US-10, US-14, US-15, US-16, US-17, US-18, US-19, US-20, US-21

Navegacao planejada:
- Principal -> principal — stories: US-00, US-02, US-03, US-04, US-05, US-06, US-07, US-08, US-09, US-10, US-14, US-15, US-16, US-17, US-18, US-19, US-20, US-21

Vocabulario obrigatorio de dominio:
- dashboard
- registros
- configuracao

Copy proibida ou arriscada:
- acesse seu ambiente
- painel operacional
- eleve sua produtividade

Dados fake recomendados:
(nao declarado)

Instrucoes especificas para Open Design:
- Gere uma SPA operacional, nao uma landing page.
- Use entidades concretas das user stories e evite copy generica.
- Nao escreva regras de negocio na tela; mostre apenas dados, estados, formularios e acoes.
- Gere os fluxos de todas as telas necessarias com navegacao clicavel.
- Arquivo unico index.html e permitido, mas telas empilhadas no scroll sao proibidas. Use [hidden] e JS real para mostrar apenas uma section por vez.

Cobertura planejada:
- US-00: principal — Cobertura deterministica.
- US-02: principal — Cobertura deterministica.
- US-03: principal — Cobertura deterministica.
- US-04: principal — Cobertura deterministica.
- US-05: principal — Cobertura deterministica.
- US-06: principal — Cobertura deterministica.
- US-07: principal — Cobertura deterministica.
- US-08: principal — Cobertura deterministica.
- US-09: principal — Cobertura deterministica.
- US-10: principal — Cobertura deterministica.
- US-14: principal — Cobertura deterministica.
- US-15: principal — Cobertura deterministica.
- US-16: principal — Cobertura deterministica.
- US-17: principal — Cobertura deterministica.
- US-18: principal — Cobertura deterministica.
- US-19: principal — Cobertura deterministica.
- US-20: principal — Cobertura deterministica.
- US-21: principal — Cobertura deterministica.

Regras para usar este plano:
- Use este plano como mapa operacional, nao como copy literal.
- Nao mostre este plano, JSON, criterios internos ou racional no HTML.
- O HTML final deve mostrar apenas a SPA funcional do produto.
- Nao gere landing page, hero, pitch comercial, galeria de telas ou secoes explicativas.
- Um index.html unico e permitido; telas empilhadas no scroll sao proibidas.
- Inclua CSS `[hidden] { display: none !important; }` e JS real para alternar qual `section` esta visivel.
- Login e app shell nunca podem coexistir visualmente. Ao submeter login, esconda login e mostre a primeira tela interna.
- Gere os fluxos de todas as telas necessarias com navegacao clicavel.
- Nao escreva regra de negocio, criterio de aceite ou contrato como texto visivel na UI.



### Como transformar stories em telas

- Agrupe stories por tarefa do usuario, entidade de dados e momento do fluxo.
- Crie o menor conjunto de telas necessario para cobrir as stories, mas inclua estados internos ricos dentro de cada tela.
- Para cada tela planejada, defina antes de codar: objetivo, stories cobertas, acoes primarias, estados, dados exibidos/editados e destino de navegacao.
- Telas comuns esperadas quando fizer sentido: autenticacao, dashboard/listagem principal, detalhe/edicao, criacao/configuracao, revisao/resultado, estado vazio/erro.
- Nao transforme cada user story em uma tela separada se elas pertencem ao mesmo fluxo.
- Nao esconda fluxos importantes em texto estatico. Use botoes, formularios, filtros, tabs ou navegacao real.
- Antes de salvar, faça uma autocritica severa: se a tela principal pudesse servir para qualquer SaaS trocando palavras, esta ruim. Reescreva para o dominio do projeto.

## Skill aplicada: Frontend de Alto Nivel (adaptada para Open Design)

Esta skill e uma camada de craft visual. Ela NUNCA substitui escopo, contrato ou rastreabilidade por user stories.

Baseline ativo:
- DESIGN_VARIANCE: 8 — layouts assimetricos e memoraveis em desktop; mobile sempre colapsa para coluna unica sem scroll horizontal.
- MOTION_INTENSITY: 6 — microinteracoes e movimento fluido, mas sem comprometer performance.
- VISUAL_DENSITY: 4 — app web claro, arejado e usavel no dia a dia.

Regras de hierarquia:
1. Contract + Design Lock vencem qualquer decisao estetica.
2. Cobertura de user stories vence qualquer ideia visual.
3. Cada tela, navegacao, acao, dado e API precisa declarar userStoryIds reais.
4. Elementos sem rastreio entram em deltas[]; nao viram escopo final escondido.

Direcao de frontend:
- Evite UI generica de IA: nada de roxo/azul neon, blobs decorativos, H1 central gigante, 3 cards iguais, nomes falsos tipo Joao da Silva/Maria Santos, numeros redondos tipo 99,99%.
- Para software/dashboard, use sans-serif premium e limpa; nao use serif; nao use preto puro; use off-black/zinc ou base clara refinada.
- Maximo 1 cor de acento, dessaturada e consistente.
- Priorize telas funcionais sobre landing page. O produto deve parecer utilizavel, nao uma peca de marketing.
- Formulario: label acima, helper text na marcacao, erro abaixo do input, estados loading/empty/error/success/disabled quando aplicavel.
- Use grid e agrupamento logico; cards so quando comunicam hierarquia real.
- Motion apenas com transform/opacity; nada de animar top/left/width/height; loops ou efeitos pesados devem ser isolados.

Adaptacao ao artifact HTML do Open Design:
- Gere HTML standalone clicavel. Nao importe React/Next/Tailwind/Framer a menos que o runtime do OD ja esteja explicitamente usando isso.
- Se precisar de icones, use SVG limpo inline. Emojis sao proibidos no HTML, labels e alt text.
- Aplique o espirito da skill no HTML/CSS/JS final: assimetria controlada, composicao premium, estados completos e interacoes reais.

## Fontes originais para conferencia

As fontes abaixo sao referencia de escopo. Nao copie blocos inteiros para a UI; extraia telas, estados, dados e acoes.

### Discovery

# Discovery Notes

---

## >>> PAROU AQUI <<<

**Data da pausa:** 2026-06-05
**Ultima fase concluida:** Q11 (Notas adicionais). Q7 dispensada.
**Proxima etapa:** **Resumo final + validacao do fundador + [PHASE_COMPLETE]**.

Estado das 11 perguntas:
- [x] Q1, Q2, Q3, Pitch, Q4, Q5, Q6, Q8, Q9, Q10, Q11
- [N/A] Q7
- [ ] **Resumo final aguardando validacao (RETOMAR AQUI)**

Fase 2 (so anotar): Email, ERP Nomus, Google Drive, WhatsApp, Web.

---

## Visao

### Problema
A operacao do grupo DLH depende de pessoas-chave e de conhecimento disperso (cabeca de funcionarios, e-mails, conversas). Quando alguem sai, viaja ou se ausenta, processos travam, decisoes se perdem e a memoria operacional evapora. Falta um ecossistema unico que centralize fontes (portais, ERP, e-mails, drive), persista memoria viva e automatize a operacao de forma continua, sem refem de individuos.

### Usuario principal
Nucleo operacional do grupo DLH:
- **Fábio**: lideranca e decisoes estrategicas.
- **Ligiane (esposa/socia)**: co-lideranca da operacao.
- **Funcionarios**: operadores do dia a dia.
- **Lia (IA)**: agente que opera dentro do LionClaw, intermediando o DLH Core com as pessoas.

Time pequeno, alta confianca, cada pessoa acumula varias responsabilidades. O DLH Core serve humanos e Lia sem fricao.

### Referencia
**SOM (Symbiotic Operating Model)** — framework autoral do fundador. O DLH Core e a primeira materializacao do SOM em software. Principios estruturais:
- Tres atores de primeira classe: empresa, IA (Lia) e pessoas.
- Niveis de autonomia configuraveis (de execucao assistida a bloqueada para acoes sensiveis).
- Memoria operacional persistente como substrato, nao log.
- Redundancia humano <-> IA: se um falta, a operacao segue.
- Rastreabilidade e governanca embutidas.

**MOE (Memoria Operacional Evolutiva)** — camada de memoria do SOM, tambem a

... (discovery compactado — 6569 chars omitidos; use como fonte de conferencia, nao como copy literal) ...

.png`.

**Acao na Fase 5 (Frontend):** o agente de frontend deve abrir o LionClaw (e/ou ler o print) pra extrair design tokens (cores, raio, espacamento, fontes, sombras) e mapear pros componentes shadcn/ui equivalentes. Discovery so registra a referencia — nao processa imagem aqui.

### Notas adicionais
**Restricao de custo de LLM (Fase 1):** o fundador NAO quer pagar API LLM por token neste momento. O consumo de Claude pelo pipeline deve ser feito exclusivamente via plano **Claude Max** ja contratado (mesmo plano usado pela Lia no LionClaw).

Implicacao tecnica a resolver na Fase 5 (Backend):
- Claude Max e plano humano (claude.ai) — nao expoe API key billable.
- Rota decidida: o pipeline delega o enriquecimento a Lia/LionClaw, que ja roda autenticada no Max. SEM uso de Agent SDK / API key paga.
- Embeddings: avaliar alternativa local ou modelo open-source (ex: rodar via Ollama) para nao depender de API paga de embeddings tambem. A definir na Fase 5.

Demais notas: nenhuma adicional levantada no discovery.

### User Stories e Requisitos aprovados

# User Stories e Requisitos — DLH Core (MVP / Fase 1)

> **Escopo deste documento:** primeiro componente do ecossistema DLH Core — **Substrato de memória + Cockpit de coleta**, com a primeira fonte (Effecti) integrada e a Lia consumindo via API LLM-ready.
> **Fonte:** `discovery20260605_192252.md` (Pitch validado em 2026-06-05).
> **Idioma:** Português brasileiro.

---

## Personas de referência

- **Fábio** — liderança e decisões estratégicas.
- **Ligiane** — co-liderança da operação.
- **Funcionário operacional** — operador do dia a dia.
- **Lia (IA)** — agente que opera dentro do LionClaw e consome o substrato via API/MCP LLM-ready.

> **Acesso no MVP:** o cockpit é de uso interno **sem distinção de papéis**. Fábio, Ligiane e funcionários compartilham um único perfil — **usuário interno do núcleo DLH** — com acesso pleno. A **Lia** é o ator de IA, que consome o substrato via API/MCP. Por isso, nas user stories os atores humanos aparecem como "usuário interno do núcleo DLH".

---

## 1. User Stories

### Domínio: Estrutura e Navegação do Cockpit

**US-00 — Estrutura e navegação do cockpit**
Como **usuário interno do núcleo DLH**, quero **um cockpit com navegação clara entre Monitoramento e Administração da ingestão**, para **operar e resolver problemas da coleta sem me perder**.
*Padrão de interface: layout com navegação persistente (menu lateral/topo) + área de conteúdo; com tela de login "Entrar com Google" (acesso autenticado).*
Critérios de aceite:
- O cockpit é de uso interno e o acesso **exige autenticação/login** (Supabase Auth, **login via Google**); no MVP há **perfil único**, com o modelo de acesso preparado para papéis no futuro.
- No **primeiro acesso**, quando ainda não há fonte configurada nem coleta executada, o cockpit apresenta um **onboarding de primeira configuração** que orienta o usuário a configurar

... (stories-requisitos compactado — 34036 chars omitidos; use como fonte de conferencia, nao como copy literal) ...

, evitando retrabalho quando a orquestração for implementada.
- **Autenticação da Lia na API/MCP:** o controle de acesso da API/MCP consumida pela Lia (como o agente se autentica) será definido na fase técnica (ver RNF-01). Sem impacto em telas.
- **Camadas de comunicação (Supabase x API/MCP do DLH Core):** há duas "APIs" distintas no sistema. (1) A comunicação **com o Supabase** ocorre via as **APIs/SDK do próprio Supabase** (REST/PostgREST sobre o Postgres, Auth, Storage e Realtime) e via **Edge Functions** (endpoints HTTP em Deno/TS); o agendamento usa pg_cron dentro do Postgres (RF-04). (2) A **Lia** **não** acessa o Postgres diretamente nem executa SQL bruto: consome o substrato pela **API/MCP LLM-ready própria do DLH Core** (US-17/US-18/RF-29/RF-30/RF-31), que entrega conteúdo verbatim + metadados + busca semântica e roda sobre o **mesmo backend** do cockpit. Essa camada própria é a que precisa ser **estável/versionada e desacoplada** (RNF-17). Detalhes de transporte/contrato ficam para a fase técnica.

## Notas adicionais do PRD Validator

(prd-validator ausente)

## Design System

- (nenhum design system selecionado — usar default coerente com o briefing)

## Configuracao da sessao (somente metadados — nao contem credenciais)

```json
{
  "agentId": "configured-in-open-design-studio",
  "model": "configured-in-open-design-studio",
  "reasoning": null,
  "designSystemId": null,
  "memoryEnabled": false,
  "mcpServerIds": [],
  "locale": "pt-BR"
}
```

## Entrega esperada

- **SPA multi-tela** seguindo o "Formato OBRIGATORIO" acima — um `<section>` por screen, um visivel por vez, transicoes por interacao real.
- `index.html` standalone unico e permitido; telas empilhadas no scroll sao proibidas.
- Bloco `lionclaw-design-contract` embutido no HTML EXATAMENTE no shape definido abaixo.
- Texto e copy em pt-BR **dentro das telas funcionais** — sem prose marketing, sem hero copy editorial, sem "## Sobre o produto", sem pitch.

Se uma user story exigir interpretacao, use o contexto disponivel, registre a decisao em `deltas[]` quando necessario e continue. Nao bloqueie a entrega com perguntas de briefing visual.

## Schema OBRIGATORIO do bloco `lionclaw-design-contract`

Este JSON eh consumido pelo validator do LionClaw. **Qualquer campo extra eh permitido, mas TODOS os campos abaixo sao obrigatorios** — sem isso o Design Lock rejeita.

```html
<script type="application/json" id="lionclaw-design-contract">
{
  "version": "1.0",
  "visual": {
    "direction": "string descritiva da direcao visual (ex: 'software dark utilitario com acento amber')",
    "density": "dense | balanced | editorial | mobile-first | unknown",
    "tokens": {
      "colors": { "bg": "#09090b", "accent": "#d97706", "...": "..." },
      "typography": { "display": "Geist", "body": "Satoshi", "...": "..." },
      "spacing": { "xs": "4px", "sm": "8px", "...": "..." },
      "radii": { "sm": "4px", "md": "8px", "...": "..." }
    }
  },
  "navigation": {
    "primary": [
      { "id": "nav-play", "label": "Jogar", "targetScreenId": "play", "userStoryIds": ["US-02"] }
    ],
    "secondary": []
  },
  "screens": [
    {
      "id": "login",
      "userStoryIds": ["US-01"],
      "title": "Login",
      "route": "#login",
      "purpose": "Autenticar usuario",
      "states": ["loading", "error", "success"],
      "actions": [
        { "id": "action-login", "label": "Entrar", "type": "submit", "userStoryIds": ["US-01"], "apiExpectationIds": ["api-login"] }
      ],
      "dataRequirementIds": ["data-user-login"]
    }
  ],
  "components": [
    { "id": "btn-primary", "name": "Botao primario", "type": "form", "usedInScreenIds": ["login"], "props": {}, "states": [] }
  ],
  "dataRequirements": [
    {
      "id": "data-user-login",
      "name": "Credenciais de login",
      "description": "Dados informados pelo usuario para autenticacao",
      "fields": [
        { "name": "email", "typeHint": "string", "required": true },
        { "name": "password", "typeHint": "string", "required": true }
      ],
      "sourceScreenIds": ["login"],
      "userStoryIds": ["US-01"]
    }
  ],
  "apiExpectations": [
    {
      "id": "api-login",
      "operation": "POST /auth/login",
      "screenIds": ["login"],
      "actionIds": ["action-login"],
      "methodHint": "POST",
      "requestShape": { "email": "string", "password": "string" },
      "responseShape": { "token": "string" },
      "userStoryIds": ["US-01"]
    }
  ],
  "deltas": [
    {
      "id": "delta-001",
      "type": "unclear",
      "description": "explicacao do delta",
      "impact": "low",
      "relatedUserStoryIds": [],
      "requiresRequirementsChange": false
    }
  ]
}
</script>
```

**Regras criticas:**
- `version` deve ser literalmente `"1.0"`.
- Cada `screens[]`, `navigation.primary[]` e `dataRequirements[]`/`apiExpectations[]` referencia user stories por `userStoryIds: string[]` (use os IDs reais do briefing, ex: `"US-01"`).
- Cada `apiExpectations[]` precisa declarar `screenIds: string[]`, `actionIds: string[]` e `userStoryIds: string[]`, mesmo que algum deles seja `[]`.
- Cada `dataRequirements[]` precisa declarar `fields[]`, `sourceScreenIds: string[]` e `userStoryIds: string[]`.
- Telas/componentes/dados/APIs SEM user story listada → registrar como `deltas[]` com `description` explicando por que existe.
- `components[]`, `apiExpectations[]`, `dataRequirements[]` e `deltas[]` exigem `id: string` unico.
- `deltas[]` exige `type`, `description`, `impact`, `relatedUserStoryIds` e `requiresRequirementsChange`.
- Use os 4 grupos de tokens (`colors`, `typography`, `spacing`, `radii`) mesmo que parcialmente vazios — eles sao obrigatorios na estrutura.

Campos adicionais ao schema (ex: `project`, `design_system`, `acceptance_criteria_visualized`) sao tolerados, mas os campos acima nao podem faltar.
