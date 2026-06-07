# Roadmap: Evolução do Cérebro (inspirado no gbrain)

> Documento de planejamento. Implementação FUTURA, faseada.
> Gerado em 2026-06-07. Editar conforme o projeto evoluir.

## 1. Contexto

O **gbrain** (Garry Tan) é um cérebro de IA maduro (produção com 146k páginas).
Ao comparar com o cérebro que o LionClaw/Lia já oferece, identificamos que os
pilares conceituais já existem (markdown-first, busca híbrida BM25+vetorial,
knowledge graph com wiki-links, ciclo de "sono" via skill `dreaming`, síntese
pela própria Lia). O gbrain está mais maduro em 4 pontos; deste comparativo
escolhemos importar **3 melhorias** para o ecossistema DLH.

Princípio-guia (SOM): **aplicável acima de completo**. Escopo enxuto, entregar
funcionando antes de ampliar. Cada item tem um PILOTO mínimo.

## 2. Divisão de papéis (não é "Lion ou gbrain")

- **Cérebro do Lion** = memória pessoal/operacional da Lia (decisões, contexto,
  conhecimento curado). Single-user.
- **dlh-core (Supabase)** = cérebro estruturado e multiusuário da empresa
  (avisos, fontes, dados acessados por nível). RLS resolve multiusuário/access
  control nativamente (gap que o Lion sozinho não cobre).

## 3. As 3 melhorias

### 3.1 Edges tipadas — mora no dlh-core

**Por quê aqui:** dados já estruturados; Postgres faz multi-hop (JOIN) nativo.
No vault do Lion edges tipadas seriam semi-manuais e frágeis.

**Insight:** metade já existe implícita. Cada aviso carrega `orgao`, `portal`,
`modalidade`, `uasg`, `cnpj` — são edges esperando para serem nomeadas.

**Passos:**
1. Migration criando tabelas-dimensão derivadas dos avisos existentes:
   `orgaos`, `portais`, `modalidades`.
2. View `grafo_arestas(origem_tipo, origem_id, tipo, destino_tipo, destino_id)`
   materializando: `aviso —publicado_por→ orgao`, `aviso —via→ portal`,
   `aviso —do_tipo→ modalidade`.
3. Multi-hop vira query SQL. Ex.: "quais órgãos mais publicam pregão eletrônico
   no ComprasNet".

**Esboço de tipos de aresta (v0):**
- `aviso --publicado_por--> orgao`
- `aviso --via--> portal`
- `aviso --do_tipo--> modalidade`
- (futuro, com Nomus) `produto --atende--> edital`, `fornecedor --fornece--> produto`

**Piloto:** só as 3 dimensões + a view. Sem produto/fornecedor (fase Nomus).
**Esforço:** baixo (1 migration + 1 view).

### 3.2 Gap analysis formal — comportamental + reforço no dlh-core

**Por quê:** é a regra SOM de "separar fato / interpretação / hipótese" +
"rastreabilidade (origem, data, status, confiabilidade, responsável)". Princípio
já existe; falta sistematizar.

**Camada A — protocolo (custo zero):**
- Toda consulta à base fecha com bloco **"Lacunas"**: o que está confirmado
  (origem + data), o que é inferência da Lia, o que falta ou está desatualizado.
- Registrar como diretriz no `SOUL.md` ou skill `consulta-com-gap` → vira hábito
  garantido, não opcional.

**Camada B — metadados (reforço no dlh-core):**
- Colunas de governança nas tabelas: `fonte`, `capturado_em`, `confiabilidade`,
  `verificado_por`.
- Gap fica automático: "dado com 30 dias, fonte única, não verificado".

**Piloto:** Camada A apenas (diretriz no SOUL). Reversível, não toca no dlh-core.
**Esforço:** quase zero.

### 3.3 Dream cycle mais rico — reusa o Lion + 1 job no dlh-core

**Por quê:** Lion já tem skills `dreaming` e `context-cleanup` + cron
(`CronCreate`). Falta agendar e adicionar enriquecimento.

**Passos:**
1. Agendar `dreaming` via cron do Lion para rodar de madrugada (já possível hoje).
2. Job de dedup no dlh-core: agrupa órgãos/fornecedores por CNPJ e sinaliza
   grafia duplicada (ex.: "PREF. MUN. X" vs "Prefeitura Municipal de X").
3. Detecção de contradição/frescor: flag de avisos com dados conflitantes ou
   status velho.
4. Relatório via Alfred (Telegram) na manhã seguinte.

**Piloto:** passo 1 (agendar dreaming) + passo 4 (relatório no Alfred).
**Esforço:** baixo no piloto; dedup é a parte média.

## 4. Ordem recomendada (escopo enxuto)

| Ordem | O quê | Esforço | Valor |
|-------|-------|---------|-------|
| 1º | Gap analysis Camada A (diretriz SOUL) | quase zero | alto, casa com SOM |
| 2º | Edges tipadas (3 dimensões + view) | baixo | alto, libera consultas novas |
| 3º | Dream cycle: agendar dreaming + relatório Alfred | baixo | médio |
| depois | Metadados de confiabilidade + dedup | médio | alto, pode esperar |

**Lógica:** começa pelo grátis e imediato (gap analysis), depois o que destrava
capacidade nova (edges), deixa o trabalho médio (dedup/metadados) para o fim.
Antídoto ao perfeccionismo: cada passo entrega algo funcionando antes de escalar.

## 4.1 Regra de blindagem contra update do Lion (CRÍTICA)

Requisito SOM: update do Lion NÃO pode quebrar a operação ("não se perde").

**Regra:** lógica CRÍTICA do cérebro roda no **pg_cron do Supabase**, não no cron
do Lion. O Lion entra só como **gatilho/conforto não-crítico**.

Risco por camada:
- **Imune a update do Lion** (vive no dlh-core/Supabase): edges tipadas, metadados
  de confiabilidade, job de dedup, jobs de contradição/frescor.
- **Acoplado ao Lion** (frágil em update): agendar skill `dreaming` via cron do
  Lion, relatório via Alfred/Telegram, regeneração do `SOUL.md`.

Mitigação:
- Os jobs de manutenção do cérebro operacional usam o **pg_cron já existente** no
  Supabase (mesma infra que protege a coleta Effecti). Não inventar agendador novo.
- O cron do Lion fica reservado à skill `dreaming` (memória PESSOAL da Lia, não
  crítica). Se quebrar num update, basta reagendar; nada operacional se perde.
- `SOUL.md`/`USER.md`/`MEMORY.md` são arquivos do usuário em `~/.lionclaw/` e
  persistem; só o `CLAUDE.md` é regenerado no boot. Editar o SOUL é seguro.

## 5. Critérios de pronto (por item)

- **Edges tipadas:** view `grafo_arestas` retornando arestas das 3 dimensões;
  ao menos 1 consulta multi-hop validada via SQL.
- **Gap analysis A:** diretriz no SOUL ativa; respostas de consulta passam a
  incluir bloco "Lacunas" consistentemente.
- **Dream cycle:** cron de `dreaming` agendado e disparando; relatório chegando
  no Alfred.

## 6. Gaps do gbrain NÃO importados (decisão consciente)

- **Schema packs / taxonomia de tipos:** adiado. dlh-core já tipa via tabelas.
- **Retrieval avançado (RRF + reranking + query rewriting):** adiado. A busca
  híbrida atual (memory-search + API LLM-ready) atende o v0.
- **Multiusuário/access control no cérebro do Lion:** não se aplica; resolvido no
  dlh-core via RLS.

## 8. Alternativa arquitetural EM AVALIAÇÃO (não decidida)

**Ideia (Fábio, 2026-06-07):** adotar o gbrain como **cérebro geral** com acesso a
tudo (dlh-core + Lion + fontes), deixando o Lion como interface/operacional.

**Status:** NÃO agora. O Lion está servindo bem. Eventual migração depende de
avaliação de **custo x valor**. Registrado só para não se perder.

**Como encaixaria (se um dia):** sem dois cérebros competindo — papéis distintos:
- dlh-core = camada operacional/transacional (fonte de verdade dos dados).
- gbrain = camada de conhecimento/raciocínio por cima (síntese, grafo, gap
  analysis, corroboração cross-source). Lê tudo, mas o dado nasce no dlh-core.
- Lion/Lia = interface/executor, consome o gbrain via MCP.

**A favor (fatos):** gbrain é Supabase-compatible (pgvector), expõe MCP,
multiusuário com access control por login, agnóstico de LLM (alinha à
portabilidade SOM).

**Custos a pesar antes de decidir:**
1. Escopo — sistema grande e novo pra manter; risco de explodir o escopo.
2. Fonte única de verdade — gbrain só LÊ/indexa; dado nasce no dlh-core.
3. Reabre o agnóstico adiado por custo (embeddings + LLM síntese + rerank pago).

**Lacunas a validar antes (não sei hoje):** esforço de setup/estabilidade no
Windows, licença, dependência de serviços pagos, trivialidade do sync contínuo
dlh-core -> gbrain (senão vira snapshot velho).

**Plano de teste de baixo risco (se for explorar):**
1. Terminar o que já está em jogo antes (2ª fonte ou análise de editais).
2. Rodar gbrain isolado, read-only, sobre cópia de dados, como MCP da Lia.
3. Medir se síntese/grafo agregam de verdade. Só então promover.

## 7. Referências

- gbrain: https://github.com/garrytan/gbrain
- Cérebro do Lion: MCPs memory-search, graph-search, knowledge-base
- dlh-core: app Next.js + Supabase (ref qvggrrirsjidtqsdvmxf)
