# Design Brief

## Direcao Visual

**Direcao:** Software dark utilitário, zinc off-black com um único acento âmbar dessaturado; densidade balanceada, sem cara de landing page
**Densidade:** balanced

## Tokens

### Cores

| Token | Valor |
|-------|-------|
| bg | #0b0b0e |
| surface | #141418 |
| surface2 | #1a1a20 |
| border | #272730 |
| fg | #e9e9ec |
| muted | #9b9ba5 |
| accent | #d99a3c |
| ok | #5cbf86 |
| run | #6f9bd9 |
| warn | #d9b14a |
| err | #dd6b62 |

### Tipografia

| Token | Valor |
|-------|-------|
| display | -apple-system / Segoe UI / Inter |
| body | -apple-system / Segoe UI / Inter |
| mono | ui-monospace / JetBrains Mono |

### Espacamento

| Token | Valor |
|-------|-------|
| xs | 4px |
| sm | 8px |
| md | 14px |
| lg | 24px |

### Radii

| Token | Valor |
|-------|-------|
| sm | 6px |
| md | 10px |
| lg | 14px |

## Mapa de Telas

- **Login** (`login`) — rota: `#login` — stories: US-00, US-21
- **Dashboard** (`dashboard`) — rota: `#dashboard` — stories: US-00, US-15, US-16, US-04, US-05, US-02
- **Execuções de sincronização** (`execucoes`) — rota: `#execucoes` — stories: US-15, US-04, US-05, US-02
- **Erros de ingestão** (`erros`) — rota: `#erros` — stories: US-16
- **Detalhe do edital** (`edital`) — rota: `#edital` — stories: US-14, US-10, US-08, US-19, US-09, US-06
- **Fontes e credenciais** (`fontes`) — rota: `#fontes` — stories: US-07, US-02
- **Configuração da ingestão** (`ingestao`) — rota: `#ingestao` — stories: US-03, US-20, US-04
- **API LLM-ready** (`api`) — rota: `#api` — stories: US-17, US-18

## Navegacao Principal

- **Dashboard** (`nav-dashboard`) -> tela `dashboard` — stories: US-00, US-15
- **Execuções** (`nav-execucoes`) -> tela `execucoes` — stories: US-00, US-04, US-05
- **Erros** (`nav-erros`) -> tela `erros` — stories: US-00, US-16
- **Fontes e credenciais** (`nav-fontes`) -> tela `fontes` — stories: US-00, US-07
- **Configuração da ingestão** (`nav-ingestao`) -> tela `ingestao` — stories: US-00, US-03, US-20
- **API LLM-ready** (`nav-api`) -> tela `api` — stories: US-00, US-17, US-18

## Componentes Principais

- **Botão Entrar com Google** (`cmp-gbtn`) — tipo: `form`
- **Navegação persistente** (`cmp-sidebar`) — tipo: `nav`
- **Card de KPI** (`cmp-stat-card`) — tipo: `card`
- **Tabela de execuções** (`cmp-runs-table`) — tipo: `table`
- **Tabela de erros** (`cmp-erros-table`) — tipo: `table`
- **Pill de status** (`cmp-status-pill`) — tipo: `badge`
- **Pipeline do item** (`cmp-pipeline`) — tipo: `indicator`
- **Formulário de credencial** (`cmp-cred-form`) — tipo: `form`
- **Formulário de configuração da ingestão** (`cmp-cfg-form`) — tipo: `form`
- **Playground de busca semântica** (`cmp-search`) — tipo: `form`

## Deltas

- **assumption** (`delta-001`) — impacto: low
  O Design Plan determinístico previa apenas 2 telas (login + principal). Para tornar a SPA operacional e evitar uma única tela genérica, a 'principal' foi decomposta em telas funcionais reais (dashboard, execucoes, erros, edital, fontes, ingestao, api) sem ampliar escopo: todas as user stories cobertas continuam sendo as aprovadas.
- **assumption** (`delta-002`) — impacto: low
  US-17 e US-18 são definidas como API/MCP sem tela própria. Foi criada a tela 'api' apenas como console de validação humana (endpoints + playground de busca semântica) para o fundador conferir implementabilidade; não introduz fluxo de produto novo.
- **unclear** (`delta-003`) — impacto: low
  US-02, US-05, US-08, US-09, US-10 e US-19 são processos de background sem UI própria. São representadas como estados/dados nas telas (status de execução incremental, pipeline do item, conteúdo verbatim e payload bruto integral no detalhe do edital), não como telas dedicadas.
- **assumption** (`delta-004`) — impacto: low
  US-06 (enriquecimento cognitivo) é explicitamente Fase 2. Aparece no pipeline do edital como etapa 'não executado na Fase 1', sem ação executável, para deixar a fronteira de escopo visível sem implementar o fluxo.
- **assumption** (`delta-005`) — impacto: low
  Modelo de embedding 'bge-m3 local' e portal futuro 'PNCP' são placeholders coerentes com a nota de discovery (evitar API paga de embeddings) — valores ilustrativos, a confirmar na fase técnica.
