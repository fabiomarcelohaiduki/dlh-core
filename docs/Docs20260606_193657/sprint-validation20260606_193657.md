# Relatorio de Validacao de Sprints - Nomus Processos

> Gerado pelo Sprint Validator. Compara SPEC.md (574 linhas) com sprints20260606_193657.json (7 sprints / 21 features).
> Data: 2026-06-06

## 1. Inventario de Sprints

| ID | Nome | Complexidade | Rounds | Deps | Features |
|----|------|--------------|--------|------|----------|
| S1 (sprint-001) | Schema, RLS, RPC generalizada e seed | medium | 2 | - | feat-001..004 |
| S2 (sprint-002) | Conector Nomus e utilitarios compartilhados | high | 3 | S1 | feat-005..008 |
| S3 (sprint-003) | Endpoints de credencial, teste e config | medium | 2 | S1,S2 | feat-009..011 |
| S4 (sprint-004) | Pipeline de coleta, coleta sob demanda e orquestrador | high | 3 | S1,S2 | feat-012..014 |
| S5 (sprint-005) | Busca semantica multi-origem para a Lia | medium | 2 | S1 | feat-015 |
| S6 (sprint-006) | Frontend: bloco Nomus na tela de Fontes | high | 3 | S1,S3,S4 | feat-016..019 |
| S7 (sprint-007) | Frontend: execucoes e erros multi-origem (Realtime) | medium | 2 | S1,S4 | feat-020,021 |

## 2. Cobertura SPEC -> Sprints (User Stories)

| US | Titulo | Sprint/Feature | Status |
|----|--------|----------------|--------|
| US-00 | Provisionar fonte Nomus (seed) | S1 / feat-004 | COBERTA (ver L1) |
| US-01 | Cadastrar credencial | S3 feat-009, S6 feat-016/019 | COBERTA |
| US-02 | Testar conexao | S3 feat-010, S6 feat-016 | COBERTA |
| US-03 | Resolver fonte por tipo | S3 (endpoints parametrizados) | COBERTA |
| US-04 | Selecionar recursos | S3 feat-011, S6 feat-017 | COBERTA |
| US-05 | Selecionar tipos por recurso | S3 feat-011, S2 feat-007, S6 feat-017 | COBERTA |
| US-06 | Coletar processos paginados | S2 feat-007 | COBERTA |
| US-07 | Throttling | S2 feat-008 | COBERTA |
| US-08 | Duas empresas | S2 feat-007, S4 feat-012 | COBERTA |
| US-09 | Persistir com dedup | S1 feat-001, S4 feat-012 | COBERTA |
| US-10 | Manter estado atualizado (hash) | S2 feat-006, S4 feat-012 | COBERTA |
| US-11 | Coletar em blocos + checkpoint | S4 feat-013 | COBERTA |
| US-12 | Sincronizar incremental (data alteracao) | S2 feat-008 (DD-02) | COBERTA |
| US-13 | Indexar conteudo textual | S4 feat-012 | COBERTA |
| US-14 | Indice agnostico de origem | S1 feat-001 | COBERTA |
| US-15 | Busca unificada com escopo | S1 feat-003, S5 feat-015 | COBERTA (ver L2) |
| US-16 | Disparar coleta sob demanda | S4 feat-013, S6 feat-018 | COBERTA |
| US-17 | Agendamento sequencial single-flight | S4 feat-014 | COBERTA |
| US-18 | Bloco Nomus na tela de Fontes | S6 feat-016..019 | COBERTA |
| US-19 | Monitorar execucoes e erros | S7 feat-020/021 | COBERTA |

Conclusao de cobertura: todas as 19 user stories tem ao menos uma sprint correspondente. Nao ha lacuna critica de feature inteira sem cobertura. Nao ha scope creep (toda feature mapeia a uma secao da SPEC).

## 3. Dependencias

- Cadeia respeitada: S1 -> S2 -> {S3,S4} -> S6; S4 -> S7; S1 -> S5.
- S3 depende de S2 (fontes-testar usa NomusConnector) - correto.
- S6 depende de S3 (credencial/testar/config) e S4 (ingestao-coletar) - correto.
- S7 depende de S4 (dados de execucoes) e S1 (Realtime publication) - correto.
- Sem dependencias circulares. Sem dependencia faltante detectada.
- STATUS: OK.

## 4. Sizing

- S4 e a sprint de maior risco: complexity=high, 3 rounds (teto do projeto), 3 features pesadas (pipeline + ingestao-coletar + ingestao-orquestrar com retomada automatica/NOMUS_MAX_RETOMADAS). Risco de estourar rounds. -> DISCUSSAO S-01.
- S5 tem 1 unica feature (feat-015) com 2 rounds. Nao e trivial (mudanca aditiva no contrato da Lia + escopo + clamp), mas e candidata a revisao de sizing. Mantida separada por stack/agente distinto (backend vs postgres da RPC). -> OK, observacao.
- Demais sprints com sizing coerente.

## 5. Criterios de aceite

- Em geral verificaveis por maquina (campos, status codes, env vars, nomes de arquivo explicitos). Boa qualidade.
- Pontos de atencao soft: criterios que dependem de "espelhar 1:1 a copy do bloco Effecti" (feat-016, feat-018) - verificaveis por comparacao com componente existente, aceitavel.

## 6. Hints e contexto

- Sprints pos-S1 referenciam corretamente arquivos/interfaces criados antes (CollectedRecord, NomusConnector, hash, endpoints). Bom encadeamento.
- architecture_notes preservam decisoes DD-01/DD-02/DD-03 e regras SEC. Bom.

## 7. Lacunas e pontos para discussao

- L1 (RESOLVIDA em 2026-06-06) - feat-004 (seed): criterio de aceite atualizado para exigir `endpoint_base` (URL base da instancia Nomus, coluna NOT NULL - secao 2.1.1). Edicao aplicada em sprints20260606_193657.json.
- L2 (DECISAO) - Hook `useBuscaSemantica` (SPEC 4.3) nao e implementado em nenhuma sprint de frontend (S6/S7). Nao ha pagina de cockpit que o consuma (mapa 4.1 nao tem tela de busca). Provavelmente intencional (busca e para a Lia via /v1, coberta em feat-015). -> Confirmar como fora de escopo do cockpit OU adicionar nota.
- L3 (MENOR) - feat-018 (FonteSaude): SPEC 4.3 diz que o Realtime atualiza tambem `FonteSaude`; o criterio so cita `useFontes`. -> Avaliar nota de Realtime/refresh em FonteSaude.
- L4 (MENOR) - `NOMUS_TIMEOUT_MS` (.env 5.3) nao e citado explicitamente em feat-008 nem feat-010 (timeout). -> Avaliar incluir no criterio do conector/teste.
- S-01 (SIZING) - Avaliar dividir S4 (pipeline | coletar | orquestrar) para reduzir risco de rounds, ou manter e aceitar o risco.

## 8. Estado da validacao

- Cobertura: APROVADA (sem lacuna critica de feature).
- L1: RESOLVIDA (endpoint_base adicionado ao feat-004).
- Pendencias remanescentes (opcionais/menores): L2, L3, L4, S-01 - nao bloqueiam aprovacao.
