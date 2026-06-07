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
- No **primeiro acesso**, quando ainda não há fonte configurada nem coleta executada, o cockpit apresenta um **onboarding de primeira configuração** que orienta o usuário a configurar a fonte Effecti (credenciais), o agendamento/janela e os filtros antes de disparar a primeira coleta, em vez de exibir um Monitoramento vazio sem direção.
- O cockpit é organizado em **módulos**; no MVP entrega o **módulo de Ingestão**. A arquitetura/navegação é extensível para **novos módulos** (ex.: Análise, Cadastro, entre outros — fases futuras) sem alterar o existente, indicando o módulo/área ativo.
- A navegação persistente dá acesso às áreas do módulo de Ingestão: **Monitoramento** (status/erros da ingestão) e **Administração da ingestão** (fontes, credenciais, agendamento).
- A home do cockpit é o painel de **Monitoramento**.
- A área ativa é destacada na navegação, indicando ao usuário em que seção ele está.
- O cockpit não oferece navegação livre nem lista de editais; o detalhe de um edital só é acessível a partir de um erro no Monitoramento.
- A área de **Administração da ingestão** é estruturada para acomodar **múltiplos ingestores/fontes** no futuro (ex.: Gmail, Nomus, entre outros — Fase 2); no MVP apenas o conector **Effecti** está ativo, sem que isso impeça a adição de novos ingestores.
- O layout segue a identidade visual do LionClaw (Tailwind + shadcn/ui, com dark mode).

**US-21 — Autenticação de acesso ao cockpit**
Como **usuário interno do núcleo DLH**, quero **acessar o cockpit fazendo login com a minha conta Google**, para **proteger as operações e configurações do sistema sem gerenciar senha própria**.
*Padrão de interface: tela de login com botão "Entrar com Google"; sessão autenticada; ação de logout.*
Critérios de aceite:
- O acesso ao cockpit exige autenticação via **Supabase Auth**; rotas do cockpit não são acessíveis sem sessão válida.
- O login é feito **exclusivamente via Google (OAuth)** no MVP — não há cadastro de e-mail/senha próprio; a tela de login apresenta a ação **"Entrar com Google"**.
- Existe fluxo de **login** (Google) e de **logout**.
- **Provisionamento de usuários:** apenas contas **previamente autorizadas** (lista de e-mails autorizados e/ou domínio de e-mail permitido) conseguem acessar. Uma conta Google não autorizada é **barrada** com mensagem clara, mesmo após autenticar no Google.
- A **lista de contas/domínios autorizados** é **gerenciável pela Administração do cockpit** (adicionar/remover), sem necessidade de alterar código ou configuração de infraestrutura.
- No MVP há um **perfil único** (sem distinção de papéis): todo usuário autorizado tem acesso pleno.
- O modelo de identidade/acesso é estruturado para evoluir para **múltiplos usuários e papéis** (permissões diferenciadas) e **outros provedores de login** no futuro, sem refatorar o existente.
- Ações sensíveis (ex.: alterar credenciais de fontes) ficam associadas ao usuário autenticado no audit trail.

---

### Domínio: Coleta e Ingestão (Conector Effecti)

**US-02 — Coleta automática de avisos (via API)**
Como **usuário interno do núcleo DLH**, quero que o sistema **colete os avisos do portal Effecti via API automaticamente**, para **não depender de ninguém acessar o portal manualmente**.
*Padrão de interface: processo de background (sem tela própria); resultado visível no Monitoramento.*
Critérios de aceite:
- O conector consome os **avisos** pela API oficial do portal Effecti.
- A coleta respeita paginação, rate limit e webhooks documentados pela API Effecti.
- Para cada aviso, o conector captura o campo da API que contém o(s) link(s) de edital, para a coleta posterior dos arquivos (US-19).
- Cada aviso coletado é persistido no substrato Supabase após passar pelo pipeline de tratamento.
- **Todos os campos do aviso retornados pela API Effecti são persistidos integralmente no substrato**, incluindo o **payload bruto completo** retornado pela API (além dos campos já modelados), sem descartar campos — alinhado ao princípio MOE de preservação do fato literal.
- Falhas de coleta são registradas e não interrompem avisos já coletados com sucesso.

**US-03 — Agendamento e janela de ingestão da coleta**
Como **usuário interno do núcleo DLH**, quero **configurar a frequência da coleta e a janela de dias dos avisos a ingerir**, para **alinhar a sincronização à rotina e trazer apenas avisos recentes e relevantes**.
*Padrão de interface: formulário de configuração na Administração da ingestão (frequência/horário + janela de dias).*
Critérios de aceite:
- É possível definir o **agendamento de execução** (frequência ou horários em que a coleta dispara), via pg_cron + Edge Functions.
- É possível definir a **janela de ingestão** em dias retroativos pela **Data de Captura** do Effecti (ex.: últimos 15, 30 ou 45 dias), de forma configurável.
- A coleta ingere apenas avisos cuja Data de Captura esteja dentro da janela configurada.
- Alterações no agendamento e na janela passam a valer na próxima execução, sem necessidade de redeploy.
- O agendamento e a janela configurados ficam visíveis na Administração da ingestão.

**US-04 — Execução de coleta sob demanda**
Como **usuário interno do núcleo DLH**, quero **disparar a coleta do Effecti manualmente**, para **buscar novidades imediatamente sem esperar o próximo agendamento**.
*Padrão de interface: ação/botão na tela de administração da ingestão.*
Critérios de aceite:
- Existe ação que dispara a coleta sob demanda independentemente do agendamento.
- A execução sob demanda usa o mesmo pipeline da coleta agendada.
- Ao disparar, a ação entra em estado de carregamento e é desabilitada enquanto a execução está em andamento, evitando disparos duplicados.
- Durante a execução, o estado "em andamento" fica visível (na própria ação e refletido no Monitoramento).
- Ao final, o sistema indica o resultado da execução (concluída, com erros, sem novos itens).
- Uma execução sob demanda não duplica itens já existentes no substrato (respeita sync incremental).

**US-05 — Sincronização incremental**
Como **usuário interno do núcleo DLH**, quero que a coleta **traga apenas o que mudou desde a última sincronização**, para **evitar reprocessamento e duplicidade de editais**.
*Padrão de interface: processo de background; estado refletido no monitoramento.*
Critérios de aceite:
- O conector identifica e processa apenas itens novos ou alterados desde a última execução bem-sucedida.
- Itens já presentes e inalterados não são reprocessados nem duplicados.
- A identidade de cada aviso/edital é o **ID do Effecti**; um aviso cujo ID já existe não é duplicado — eventos como errata, prorrogação ou cancelamento chegam do Effecti como avisos com ID próprio e são tratados pela deduplicação, não por versionamento.
- O marcador de última sincronização é atualizado somente após execução bem-sucedida.

**US-07 — Administração de fontes e credenciais**
Como **usuário interno do núcleo DLH**, quero **gerenciar as fontes de ingestão e suas credenciais**, para **manter a coleta funcionando sem editar código**.
*Padrão de interface: tela de administração (lista de fontes + formulário de credenciais).*
Critérios de aceite:
- É possível visualizar a fonte Effecti e o estado de sua configuração.
- É possível registrar/atualizar as credenciais de acesso à API Effecti.
- A arquitetura de fontes/ingestores é extensível para novos conectores (ex.: Gmail, Nomus, entre outros — Fase 2) sem alterar os já existentes; no MVP apenas o Effecti está ativo.
- Credenciais não são exibidas em texto pleno após salvas.

**US-19 — Coleta e tratamento dos arquivos de edital a partir do link**
Como **usuário interno do núcleo DLH**, quero que o sistema **baixe e trate os arquivos de edital referenciados no link de cada aviso**, para **que o conteúdo do edital entre no banco já utilizável**.
*Padrão de interface: processo de background; falhas visíveis no Monitoramento.*
Critérios de aceite:
- A partir do(s) link(s) de edital de cada aviso, o sistema baixa o(s) arquivo(s) referenciado(s) (um link pode conter um ou mais arquivos).
- O tratamento suporta múltiplas extensões (ex.: PDF, PDF digitalizado/imagem com OCR, ZIP, RAR, DOC, DOCX, DOT, entre outras): arquivos compactados são descompactados e o conteúdo textual é extraído.
- O conteúdo extraído de cada arquivo é encadeado no pipeline de enriquecimento antes de ser persistido.
- O conteúdo extraído é preservado integralmente (incluindo a tabela de descrição dos itens, mantida idêntica); a segmentação para enriquecimento não descarta nem altera o conteúdo literal persistido.
- Os editais são persistidos vinculados ao aviso de origem (rastreabilidade aviso -> edital).
- Falhas de download, extensão não suportada ou arquivo corrompido são registradas como erro do item, sem interromper os demais, e ficam visíveis no Monitoramento.

**US-20 — Seleção de modalidades e portais a ingerir**
Como **usuário interno do núcleo DLH**, quero **selecionar quais modalidades de licitação e quais portais o sistema deve ingerir**, para **trazer apenas o que é relevante para a operação e reduzir ruído**.
*Padrão de interface: formulário de filtros na Administração da ingestão.*
Critérios de aceite:
- É possível selecionar uma ou mais **modalidades de licitação** a ingerir.
- É possível selecionar um ou mais **portais** (de origem, cobertos pelo Effecti) a ingerir.
- A coleta ingere apenas avisos que correspondam às modalidades e aos portais selecionados.
- Alterações nos filtros passam a valer na próxima execução, sem necessidade de redeploy.
- Os filtros configurados ficam visíveis na Administração da ingestão.

---

### Domínio: Pipeline de Tratamento e Indexação (busca semântica)

**US-08 — Indexação para busca e preservação verbatim na ingestão**
Como **Lia (IA)**, quero que **cada aviso e o conteúdo do seu edital sejam preservados (verbatim) e indexados para busca semântica já na ingestão**, para **localizar o edital relevante sem depender do enriquecimento cognitivo, que é feito sob demanda na análise (Fase 2)**.
*Padrão de interface: processo de background.*
Critérios de aceite:
- Cada item coletado (aviso + conteúdo de edital tratado) é tratado e indexado antes de gravar no substrato.
- São gerados embeddings do item (por segmento, quando extenso) para busca semântica — **sem uso de Claude**.
- O conteúdo literal extraído — em especial a tabela de descrição dos itens — é persistido de forma íntegra e idêntica (verbatim), nunca resumido nem alterado.
- O **enriquecimento cognitivo via Claude** (campos-chave, resumo, classificação MOE) **não** é executado na ingestão; é feito **sob demanda na análise (Fase 2)**, apenas para os avisos que entram em análise.
- A segmentação/chunking de editais extensos serve **apenas** à geração de embeddings, sem reduzir ou alterar o conteúdo literal armazenado.
- Itens que falham no tratamento/indexação são marcados e não bloqueiam o restante do lote.

---

### Domínio: Substrato de Memória (Supabase / MOE)

**US-10 — Persistência da memória operacional**
Como **usuário interno do núcleo DLH**, quero que os editais coletados **fiquem persistidos no substrato**, para **que o conhecimento não dependa da cabeça de ninguém**.
*Padrão de interface: processo de background; consumo pela Lia via API e, para humanos, apenas no detalhe acessado na investigação de erro.*
Critérios de aceite:
- Itens coletados, tratados e indexados são gravados no substrato Supabase modelado pela MOE.
- Cada aviso é gravado com **todos os seus campos de origem** (conteúdo integral retornado pela API Effecti, preservado como payload bruto completo), garantindo o registro completo para consulta e enriquecimento futuro.
- Cada item registra rastreabilidade (origem, execução que o gerou) e confiabilidade.
- O substrato mantém o histórico/audit trail de alterações dos itens (propriedade da MOE).
- Cada aviso registra as datas-chave do Effecti (Data Inicial, Data Final, Data de Captura, Data de Publicação), permitindo derivar sua validade (válido até a Data Final).
- Avisos vencidos (após a Data Final) NÃO são removidos na ingestão; a memória é preservada no substrato (MOE). A remoção/filtragem de vencidos ocorre na fase de análise (Fase 2), fora deste MVP.
---

### Domínio: Cockpit — Inspeção de Edital (na investigação de erro)

**US-14 — Detalhe de um edital na investigação de erro**
Como **usuário interno do núcleo DLH**, quero **abrir o detalhe de um edital específico ao investigar um erro de ingestão**, para **entender o que falhou naquele item**.
*Padrão de interface: tela de detalhe acessada a partir de um erro no Monitoramento (não há lista nem busca livre de editais).*
Critérios de aceite:
- O detalhe é acessível somente a partir de um item/erro listado no Monitoramento.
- O detalhe exibe campos-chave, resumo, classificação e categoria MOE do item (quando disponíveis).
- O detalhe exibe a origem (rastreabilidade) do item.
- A tela trata explicitamente os estados de carregamento do detalhe e de edital não encontrado/indisponível.

---

### Domínio: Cockpit — Monitoramento Operacional

**US-15 — Status e healthcheck da ingestão**
Como **usuário interno do núcleo DLH**, quero **ver o status das execuções e a saúde da ingestão**, para **saber se a coleta está funcionando sem investigar logs**.
*Padrão de interface: dashboard de monitoramento.*
Critérios de aceite:
- O dashboard exibe o status das execuções de sincronização (concluída, em andamento, com erro).
- O dashboard exibe a data/hora da última sincronização bem-sucedida.
- Uma execução em andamento (agendada ou sob demanda) é visível no dashboard enquanto roda, com atualização do status ao concluir.
- Durante a ingestão, o dashboard exibe ao vivo o progresso da execução: total de avisos/editais a processar e quantos já foram ingeridos até o momento.
- A atualização do dashboard é **ao vivo/dinâmica** (tempo real, sem necessidade de recarregar a página).
- O dashboard mostra **em que etapa do pipeline** a execução está (coleta de avisos → download/tratamento dos arquivos de edital → indexação/embeddings → persistência), com contagem por etapa.
- O dashboard apresenta um **resumo da execução atual**: total a processar, processados com sucesso, com erro e pendentes, além do tempo decorrido.
- O dashboard exibe o **histórico das últimas execuções** (data/hora, duração, resultado e nº de itens).
- O dashboard exibe um indicador de saúde (healthcheck) da ingestão com três estados objetivos:
  - **Saudável**: última sincronização concluída com sucesso, sem itens com erro pendentes e dentro do agendamento esperado.
  - **Atenção**: última sincronização concluída com erros parciais (alguns itens falharam) e/ou execução atrasada em relação ao agendamento.
  - **Falha**: última sincronização falhou por completo ou não há execução bem-sucedida dentro da janela esperada.
- Quando o healthcheck entra em **Falha** (ou uma sincronização falha por completo), o sistema dispara uma **notificação proativa** ao(s) usuário(s) autorizado(s) — ex.: por e-mail — para que a coleta não fique interrompida sem que ninguém perceba.
- O dashboard trata explicitamente os estados de carregamento, vazio (nenhuma execução registrada ainda) e erro ao carregar os dados de monitoramento.

**US-16 — Visibilidade de erros de coleta**
Como **usuário interno do núcleo DLH**, quero **ver os erros ocorridos na coleta, no tratamento dos arquivos de edital e na indexação**, para **agir sobre o que falhou**.
*Padrão de interface: lista de erros no dashboard de monitoramento.*
Critérios de aceite:
- Erros de coleta, de tratamento de arquivos de edital e de indexação/embeddings ficam listados com identificação do item/execução afetada.
- Cada erro registra horário de ocorrência.
- Cada erro exibe o link do aviso de origem e a descrição/causa do erro, para o usuário resolver.
- Cada item com erro oferece uma ação de **reprocessar/retentar** (manual), que reenvia apenas aquele item ao pipeline sem reexecutar toda a coleta; o resultado da retentativa atualiza o status do item.
- Erros são reportados ao Sentry e refletidos nos logs nativos do Supabase.
- A tela trata explicitamente os estados de carregamento, vazio (nenhum erro no período, sinalizando "sem ocorrências") e falha ao carregar a lista de erros.

---

### Domínio: API/MCP LLM-ready (Consumo pela Lia)

**US-17 — Consumo do substrato pela Lia via API LLM-ready**
Como **Lia (IA)**, quero **consumir o substrato via API/MCP LLM-ready**, para **obter contexto pronto sem executar SQL bruto**.
*Padrão de interface: API/MCP (sem tela).*
Critérios de aceite:
- A API/MCP expõe os itens do substrato como contexto consumível pela Lia — conteúdo literal (verbatim) e metadados estruturados — não JSON cru nem SQL bruto.
- A API/MCP usa o mesmo backend do cockpit.
- A API/MCP disponibiliza a categoria MOE / enriquecimento cognitivo de cada item quando ele tiver sido enriquecido na análise (Fase 2).

**US-18 — Busca semântica via API LLM-ready**
Como **Lia (IA)**, quero **consultar o substrato por busca semântica via API**, para **recuperar editais relevantes ao contexto de uma decisão**.
*Padrão de interface: API/MCP (sem tela).*
Critérios de aceite:
- A API/MCP aceita consulta semântica e retorna itens por relevância usando embeddings.

---

## 2. Requisitos Funcionais

### Domínio: Estrutura e Navegação do Cockpit
- **RF-32** — O sistema deve oferecer um cockpit **modular** de uso interno (com acesso autenticado) com navegação persistente; no MVP entrega o **módulo de Ingestão** (áreas Monitoramento — home — e Administração), com a estrutura preparada para novos módulos (ex.: Análise, Cadastro) sem alterar o existente, e indicação do módulo/área ativo. *(Relacionado a US-00)*
- **RF-38** — O sistema deve exigir autenticação (Supabase Auth) para acessar o cockpit, com login **exclusivamente via Google (OAuth)** no MVP: rotas protegidas exigem sessão válida; apenas contas **previamente autorizadas** (lista de e-mails e/ou domínio permitido) têm acesso, barrando contas Google não autorizadas; **perfil único** no MVP e o modelo de identidade/acesso **preparado para múltiplos usuários, papéis e outros provedores de login** no futuro; ações sensíveis ficam associadas ao usuário autenticado no audit trail. *(Relacionado a US-21)*
- **RF-39** — O sistema deve permitir gerenciar pela Administração do cockpit a lista de contas/domínios autorizados a acessar (adicionar/remover), sem alteração de código ou de configuração de infraestrutura. *(Relacionado a US-21)*

### Domínio: Coleta e Ingestão (Conector Effecti)
- **RF-03** — O sistema deve coletar os avisos via API oficial do portal Effecti (respeitando paginação, rate limit e webhooks), capturar em cada aviso o campo com o(s) link(s) de edital e **persistir integralmente todos os campos do aviso retornados pela API (incluindo o payload bruto completo), sem descartar campos**. *(Relacionado a US-02, US-10)*
- **RF-04** — O sistema deve permitir configurar agendamento de execução da coleta via pg_cron + Supabase Edge Functions. *(Relacionado a US-03)*
- **RF-05** — O sistema deve permitir configurar a janela de ingestão em dias retroativos pela Data de Captura do Effecti (ex.: 15/30/45 dias), ingerindo apenas avisos com Data de Captura dentro da janela. *(Relacionado a US-03)*
- **RF-06** — O sistema deve permitir disparar a coleta sob demanda usando o mesmo pipeline da coleta agendada. *(Relacionado a US-04)*
- **RF-07** — O sistema deve executar sincronização incremental, processando apenas itens novos ou alterados desde a última execução bem-sucedida e usando o **ID do Effecti** como chave de deduplicação. *(Relacionado a US-05)*
- **RF-10** — O sistema deve permitir gerenciar fontes de ingestão e suas credenciais pela interface, sem alteração de código. *(Relacionado a US-07)*
- **RF-11** — A arquitetura de conectores/ingestores deve ser extensível para novas fontes (ex.: Gmail, Nomus, entre outras — Fase 2) sem alterar os conectores existentes; no MVP apenas o Effecti está ativo. *(Relacionado a US-07, US-00)*
- **RF-33** — O sistema deve, a partir do(s) link(s) de edital de cada aviso, baixar e tratar o(s) arquivo(s) referenciado(s) — suportando múltiplas extensões (PDF, PDF digitalizado com OCR, ZIP, RAR, DOC, DOCX, DOT, entre outras), descompactando arquivos compactados e extraindo o conteúdo textual — antes do enriquecimento, persistindo os editais vinculados ao aviso de origem. *(Relacionado a US-19)*
- **RF-34** — O sistema deve permitir configurar filtros de coleta por modalidade de licitação e por portal (de origem, coberto pelo Effecti), ingerindo apenas avisos que correspondam aos filtros selecionados. *(Relacionado a US-20)*
- **RF-35** — O sistema deve fornecer feedback de execução: ao disparar a coleta sob demanda, a ação entra em estado de carregamento/desabilitada; a execução em andamento (agendada ou sob demanda) fica visível no Monitoramento; e o resultado é indicado ao final (concluída, com erros, sem novos itens). *(Relacionado a US-04, US-15)*

### Domínio: Pipeline de Tratamento e Indexação (busca semântica)
> O enriquecimento cognitivo via Claude (campos-chave, resumo, classificação MOE) é feito **sob demanda na análise (Fase 2)**; na Fase 1 o pipeline trata o conteúdo e o indexa para busca.
- **RF-12** — O sistema deve processar cada item coletado pelo pipeline de tratamento e indexação (download/OCR/extração + embeddings) antes de gravá-lo no substrato. *(Relacionado a US-08, US-10)*
- **RF-14** — O sistema deve gerar embeddings de cada item (por segmento, quando extenso) para busca semântica, sem uso de Claude. *(Relacionado a US-08, US-18)*
- **RF-36** — O sistema deve preservar o conteúdo literal extraído do edital — em especial a tabela de descrição dos itens — de forma íntegra e idêntica (verbatim), sem resumo nem alteração. *(Relacionado a US-08, US-19)*
- **RF-37** — O sistema deve processar editais extensos por segmentação/chunking apenas para geração de embeddings, sem reduzir ou alterar o conteúdo literal armazenado. *(Relacionado a US-08, US-19)*

### Domínio: Substrato de Memória (Supabase / MOE)
- **RF-18** — O sistema deve persistir itens coletados, tratados e indexados no substrato Supabase modelado pela MOE. *(Relacionado a US-10)*
- **RF-19** — O sistema deve registrar, por item, rastreabilidade (origem e execução geradora) e confiabilidade. *(Relacionado a US-10)*
- **RF-20** — O sistema deve manter histórico/audit trail de alterações dos itens no substrato (propriedade da MOE). *(Relacionado a US-10)*
- **RF-21** — O sistema deve oferecer busca semântica por embeddings (pgvector), ordenando resultados por relevância. *(Relacionado a US-18)*

### Domínio: Cockpit — Inspeção de Edital (na investigação de erro)
- **RF-24** — O sistema deve exibir a tela de detalhe de um edital (campos-chave, resumo, classificação, categoria MOE e origem/rastreabilidade), acessível somente a partir de um erro no Monitoramento. *(Relacionado a US-14)*

### Domínio: Cockpit — Monitoramento Operacional
- **RF-26** — O sistema deve exibir dashboard com status das execuções, data/hora da última sincronização bem-sucedida e indicador de healthcheck em três estados objetivos — Saudável (última sync ok, sem erros pendentes e no prazo), Atenção (sync com erros parciais ou atrasada) e Falha (última sync falhou ou sem sync bem-sucedida na janela esperada), além do progresso ao vivo da ingestão (total a processar vs já ingeridos até o momento). A atualização deve ser em tempo real (sem recarregar), exibindo a etapa atual do pipeline (coleta → download/tratamento → indexação → persistência), o resumo da execução (sucesso/erro/pendentes/tempo) e o histórico das últimas execuções. *(Relacionado a US-15)*
- **RF-27** — O sistema deve listar erros de coleta, tratamento de arquivos de edital e indexação/embeddings com item/execução afetada, horário de ocorrência, link do aviso de origem e descrição/causa do erro. *(Relacionado a US-16)*
- **RF-28** — O sistema deve reportar erros ao Sentry e registrar execuções/syncs/audit trail nos logs nativos do Supabase. *(Relacionado a US-16)*
- **RF-40** — O sistema deve permitir reprocessar/retentar manualmente um item que falhou, reenviando apenas aquele item ao pipeline (sem reexecutar toda a coleta) e atualizando seu status conforme o resultado. *(Relacionado a US-16)*
- **RF-41** — O sistema deve disparar uma notificação proativa ao(s) usuário(s) autorizado(s) (ex.: e-mail) quando o healthcheck entrar em Falha ou uma sincronização falhar por completo. *(Relacionado a US-15)*

### Domínio: API/MCP LLM-ready
- **RF-29** — O sistema deve expor API/MCP que entrega os itens do substrato como contexto consumível pela Lia (conteúdo literal verbatim + metadados estruturados; não JSON cru nem SQL bruto), usando o mesmo backend do cockpit. *(Relacionado a US-17)*
- **RF-30** — A API/MCP deve disponibilizar a categoria MOE de cada item quando ele tiver sido enriquecido na análise (Fase 2). *(Relacionado a US-17)*
- **RF-31** — A API/MCP deve aceitar consulta semântica e retornar itens por relevância. *(Relacionado a US-18)*

---

## 3. Requisitos Não-Funcionais

### Segurança
- **RNF-01** — O acesso ao cockpit exige **autenticação (Supabase Auth)**. No MVP há **perfil único** (sem distinção de papéis); o modelo de identidade/acesso é **preparado para evoluir para múltiplos usuários e papéis**. O controle de acesso da API/MCP consumida pela Lia será definido na fase técnica. *(Atualiza a decisão do P11 — ver P27)*
- **RNF-02** — Credenciais de fontes (ex: API Effecti) não devem ser exibidas em texto pleno após salvas. *(Relacionado a RF-10)*
- **RNF-04** — Nenhum enriquecimento deve consumir API Claude paga por token; quando houver enriquecimento cognitivo via Claude (na análise — Fase 2), deve ocorrer exclusivamente pelo plano Claude Max já contratado. *(Decisão de custo)*

### Confiabilidade
- **RNF-05** — Falhas em itens individuais (coleta de aviso, download/tratamento de arquivos de edital ou indexação/embeddings) não devem interromper o processamento dos demais itens do lote. *(Relacionado a RF-33, RF-14)*
- **RNF-06** — O marcador de última sincronização só deve ser atualizado após execução bem-sucedida, garantindo retomada sem perda de itens. *(Relacionado a RF-07)*
- **RNF-07** — A sincronização incremental não deve gerar itens duplicados no substrato, usando o **ID do Effecti** como chave de deduplicação. *(Relacionado a RF-07)*
- **RNF-08** — Toda execução, sync e operação sensível deve gerar audit trail rastreável (logs nativos Supabase + Sentry para erros). *(Relacionado a RF-28)*

### Performance
- **RNF-09** — A busca semântica deve usar índice vetorial (pgvector) para evitar varredura completa da base. *(Relacionado a RF-21)*
- **RNF-10** — A coleta deve respeitar o rate limit documentado da API Effecti, sem exceder os limites da fonte. *(Relacionado a RF-03)*

### Usabilidade
- **RNF-11** — O cockpit deve ser web responsivo, otimizado para desktop e funcional no navegador móvel (consulta de status e leitura de resumo), sem app nativo. *(Plataforma definida no discovery)*
- **RNF-12** — O cockpit deve replicar a identidade visual do LionClaw (paleta, tipografia, hierarquia, densidade, componentes), incluindo dark mode, via Tailwind + shadcn/ui. *(Referência visual definida no discovery)*

### Manutenibilidade / Arquitetura
- **RNF-13** — A stack deve ser mono-linguagem TypeScript de ponta a ponta (Next.js 15 App Router no frontend; Supabase Edge Functions/Deno no backend). *(Stack definida no discovery)*
- **RNF-14** — O substrato deve ser único (Supabase: Postgres + Auth + Storage + Edge Functions), minimizando peças móveis. *(Stack definida no discovery)*
- **RNF-15** — A camada de conectores deve permitir adicionar novas fontes sem refatorar as existentes. *(Relacionado a RF-11)*
- **RNF-16** — O cockpit deve ter arquitetura **modular**: novos módulos (ex.: Análise, Cadastro, automações) podem ser adicionados sem refatorar os módulos existentes. O objetivo de longo prazo é permitir **configurar automações pela própria interface, sem alterar código**. No MVP, apenas o módulo de Ingestão é entregue. *(Visão de arquitetura — fases futuras)*
- **RNF-17** — A integração do DLH Core com o **LionClaw** e a **Lia** deve ocorrer por contratos **estáveis e versionados** (API/MCP), com **baixo acoplamento**: atualizações do LionClaw (e vice-versa) não devem quebrar o DLH Core. A identidade visual do LionClaw é **replicada** (componentes próprios), não importada em runtime, evitando dependência de release. *(Visão de arquitetura)*

---

## Notas de fronteira (Fase 1)

- **Embeddings:** o discovery registra que a estratégia de geração de embeddings (alternativa local/open-source, ex: Ollama) ainda será definida na Fase 5 (Backend). Os requisitos acima exigem embeddings, mas não fixam o provedor.
- **Itens fora do MVP (Fase 2, apenas anotados no discovery):** e-mails (Gmail/Outlook/IMAP), ERP Nomus, Google Drive, WhatsApp (Cloud API), Web (scraping/busca) e automações setoriais — não fazem parte deste conjunto de requisitos.
- **Decisão de escopo do fundador (2026-06-05, sobrepõe o discovery):** o cockpit é painel de controle da ingestão (Monitoramento + Administração) e **sem navegação/leitura livre de editais por humanos**. Os editais são consumidos pela Lia via API/MCP LLM-ready; o único acesso humano a um edital é o detalhe aberto na investigação de um erro de ingestão. **Revisão posterior (ver P27):** a decisão inicial de "sem login" foi **revertida** — o cockpit passou a **exigir autenticação** (Supabase Auth, perfil único no MVP, preparado para papéis), pois o cockpit evoluiu para um sistema operacional integrado (administra credenciais, configura automações, integra-se ao LionClaw/Lia). **Detalhamento (ver P29):** o login é feito **exclusivamente via Google (OAuth)** no MVP; o acesso é restrito a **contas previamente autorizadas** (lista de e-mails e/ou domínio permitido); e o **primeiro acesso** oferece um **onboarding de primeira configuração** (Effecti, agendamento/janela e filtros) antes da primeira coleta. Outros provedores de login e papéis ficam para fases futuras.
- **Cockpit modular e automações configuráveis (fases futuras):** o cockpit é concebido como um **shell modular**. No MVP entrega apenas o **módulo de Ingestão**. Módulos como **Análise**, **Cadastro** e outros serão adicionados conforme a evolução, com o objetivo de permitir **configurar automações pela própria interface, sem mexer no código**. Esses módulos e o motor de automação no-code estão **fora do MVP** — aqui registra-se apenas o princípio de arquitetura (US-00/RF-32/RNF-16) para que a base já nasça extensível.
- **Integração LionClaw + Lia (baixo acoplamento):** o DLH Core deve trabalhar integrado ao LionClaw e à Lia, mas **sem dependência rígida**: a comunicação se dá por contratos **estáveis e versionados** (API/MCP) e a identidade visual é **replicada** (não acoplada ao código do LionClaw em runtime), de modo que **atualizar o LionClaw não quebre o DLH Core**. Detalhes do contrato e do versionamento serão definidos na fase técnica. *(US-17/US-18/RNF-12/RNF-17)*
- **Validade e remoção (análise — Fase 2):** na Fase 1, avisos vencidos (após a Data Final da proposta) **não** são removidos na ingestão — a memória é preservada no substrato (MOE) e as datas-chave do Effecti ficam persistidas para derivar a validade. A remoção ocorre apenas na **análise (Fase 2)**, na **primeira triagem**: avisos reprovados na triagem são descartados e **nem chegam ao ERP Nomus** (é aqui que cai a maior parte — ~70%). Avisos aprovados na triagem seguem para o **Nomus**; uma eventual **reprovação humana no Nomus NÃO exclui o item** — ela vira **feedback/aprendizado na memória (MOE)** e é preservada. Todo esse fluxo é Fase 2, fora do MVP.
- **Errata/prorrogação/cancelamento e deduplicação:** confirmado pelo fundador que esses eventos chegam do Effecti como **avisos com ID próprio**; não há, portanto, versionamento de um mesmo edital. A integridade é garantida por **deduplicação pelo ID do Effecti** (US-05/RF-07/RNF-07). A US-06 e os RF-08/RF-09 (versionamento de editais) foram removidos. O histórico/audit trail de alterações permanece como propriedade da MOE no substrato (US-10/RF-20).
- **Enriquecimento cognitivo sob demanda (Fase 2):** decisão do fundador — na Fase 1 a ingestão **não** executa o enriquecimento via Claude (campos-chave, resumo, classificação MOE). O conteúdo é preservado (verbatim) e **indexado para busca semântica (embeddings)**; o enriquecimento cognitivo é feito **sob demanda na análise (Fase 2)**, apenas para os avisos que entram em análise. Racional: cerca de **70% dos avisos são reprovados na primeira triagem da análise** (não atendem aos requisitos de negócio) e nem chegam ao Nomus, então enriquecer todos na ingestão desperdiçaria Claude Max. A US-09 (distinção fato/hipótese via MOE) e os RF-13/RF-15/RF-16/RF-17 foram movidos para a Fase 2.
- **Editais extensos e fidelidade do conteúdo:** o conteúdo literal extraído (em especial a **tabela de descrição dos itens**) é persistido **íntegro e idêntico (verbatim)**, nunca resumido. Na Fase 1, a segmentação/chunking serve **apenas à geração de embeddings**, **sem alterar o literal**. O enriquecimento cognitivo (resumo/classificação MOE) e os limites de throughput/contexto do Claude Max são tratados na análise (Fase 2) / fase técnica.
- **Níveis de autonomia da Lia (SOM):** o princípio de níveis de autonomia configuráveis (de execução assistida a bloqueada para ações sensíveis) governa ações operacionais/decisões da Lia e fica **fora do MVP** (Fase 2). Na Fase 1, a Lia atua como **consumidora do substrato** (busca semântica), sem executar ações operacionais autônomas; o enriquecimento cognitivo via Claude ocorre na análise (Fase 2).
- **Orquestração de subagentes pela Lia (Fase 2):** a Lia deverá orquestrar **subagentes** para executar tarefas (modelo multiagente). Isso é uma capacidade **operacional/autônoma** e, portanto, fica **fora do MVP** (Fase 2), alinhada aos níveis de autonomia (SOM) acima. Implicação para a Fase 1: a **API/MCP (US-17/US-18)** já deve nascer **compatível com consumo agêntico** (pela Lia e por seus subagentes), por meio de contratos estáveis/versionados (RNF-17), evitando retrabalho quando a orquestração for implementada.
- **Autenticação da Lia na API/MCP:** o controle de acesso da API/MCP consumida pela Lia (como o agente se autentica) será definido na fase técnica (ver RNF-01). Sem impacto em telas.
- **Camadas de comunicação (Supabase x API/MCP do DLH Core):** há duas "APIs" distintas no sistema. (1) A comunicação **com o Supabase** ocorre via as **APIs/SDK do próprio Supabase** (REST/PostgREST sobre o Postgres, Auth, Storage e Realtime) e via **Edge Functions** (endpoints HTTP em Deno/TS); o agendamento usa pg_cron dentro do Postgres (RF-04). (2) A **Lia** **não** acessa o Postgres diretamente nem executa SQL bruto: consome o substrato pela **API/MCP LLM-ready própria do DLH Core** (US-17/US-18/RF-29/RF-30/RF-31), que entrega conteúdo verbatim + metadados + busca semântica e roda sobre o **mesmo backend** do cockpit. Essa camada própria é a que precisa ser **estável/versionada e desacoplada** (RNF-17). Detalhes de transporte/contrato ficam para a fase técnica.
