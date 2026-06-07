# Relatório de Validação de Sprints — DLH Core (Development Pipeline 2.0)

- Data: 2026-06-06
- SPEC: C:\Users\Dell\dlh-core\SPEC.md
- Plano de sprints: C:\Users\Dell\dlh-core\docs\Docs20260605_192252\sprints20260605_192252.json
- Design contract: C:\Users\Dell\dlh-core\docs\Docs20260605_192252\design\design-contract.json
- Total de sprints: 9 | Total de features: 31

---

## 1. Cobertura SPEC -> Sprints

| Área da SPEC | Sprint | Status |
|---|---|---|
| Schema, RLS, triggers, índices HNSW, view, seed (seção 2) | sprint-001 | COBERTO |
| _shared (auth/supabase/audit), auth-google, endpoints leitura, detalhe edital | sprint-002 | COBERTO |
| Credencial Vault, config ingestão, conector Effecti | sprint-003 | COBERTO |
| Pipeline (coleta/tratamento/indexação/persistência), reprocesso, notify | sprint-004 | COBERTO |
| Busca semântica /v1 + token de serviço Lia | sprint-005 | COBERTO |
| Scaffold Next.js, tokens, middleware, shell/sidebar, login | sprint-006 | COBERTO |
| Dashboard + Execuções (Realtime) | sprint-007 | COBERTO |
| Erros + Detalhe do edital | sprint-008 | COBERTO |
| Administração (Fontes, Ingestão) + API LLM-ready | sprint-009 | COBERTO |

- 11/11 apiExpectations do Design Contract resolvidas nas sprints.
- 8/8 telas do Design Contract cobertas (login, dashboard, execucoes, erros, edital, fontes, ingestao, api).
- 10/10 componentes do Design Contract atribuídos a sprints.
- Nenhum endpoint/tela/componente fora do Design Lock (sem scope creep).

## 2. Regras de Design Lock (obrigatórias deste pipeline)

| Sprint | touchesUI | affectedScreenIds | designArtifactPath | IDs válidos (contract) | Resultado |
|---|---|---|---|---|---|
| sprint-001..005 | false | [] | null | n/a | PASS |
| sprint-006 | true | login,dashboard,execucoes,erros,fontes,ingestao,api,edital | definido | sim | PASS |
| sprint-007 | true | dashboard,execucoes | definido | sim | PASS |
| sprint-008 | true | erros,edital | definido | sim | PASS |
| sprint-009 | true | fontes,ingestao,api | definido | sim | PASS |

- Nenhuma sprint com touchesUI=true e affectedScreenIds vazio -> regra de FAIL NÃO acionada.
- Todos os screenIds e componentIds existem no design-contract.json.
- designArtifactPath presente em todas as sprints com touchesUI=true.

## 3. Achados

### S1 — [CRÍTICO] Dependência faltante de sprint-007 em sprint-008
- sprint-008 (Erros + Edital) reutiliza `cmp-erros-table` e `cmp-status-pill`, criados em sprint-007 (feat-024).
- Os hints de sprint-008 citam explicitamente "components/cockpit/erros-table.tsx e status-pill.tsx (sprint-007)".
- Porém `dependencies` de sprint-008 = [sprint-001, sprint-002, sprint-004, sprint-006] — falta sprint-007.
- Risco: se o grafo de dependências for usado para ordenar/paralelizar, o Coder pode iniciar sprint-008 sem os componentes compartilhados existirem.
- Ação proposta: adicionar "sprint-007" às dependências de sprint-008.
- Status: RESOLVIDO (2026-06-06) — "sprint-007" adicionado ao array dependencies de sprint-008.

### S2 — [CRÍTICO] Dependência faltante de sprint-007 em sprint-009
- sprint-009 (Administração + API) reutiliza `cmp-status-pill`, criado em sprint-007 (feat-024).
- Os hints e architecture_notes citam "Reutilize cmp-status-pill da sprint-007".
- Porém `dependencies` de sprint-009 = [sprint-001, sprint-003, sprint-004, sprint-005, sprint-006] — falta sprint-007.
- Ação proposta: adicionar "sprint-007" às dependências de sprint-009.
- Status: RESOLVIDO (2026-06-06) — "sprint-007" adicionado ao array dependencies de sprint-009.

### S3 — [INFORMATIVO] RF-39 (gestão de allowlist) sem feature explícita
- A SPEC menciona RF-39 (gerir contas/domínios autorizados pela Administração sem deploy) como nota dentro de sprint-009, mas não há feature/critério de aceite nem endpoint dedicado.
- Coerente com o Design Lock: as 11 apiExpectations não incluem CRUD de allowlist e não há tela/menu para isso. Mantido como nota.
- Ação proposta: nenhuma alteração obrigatória (fica como observação).
- Status: ACEITO COMO ESTÁ

### S4 — [INFORMATIVO] Sprints densas (sizing)
- sprint-001 (5 features, fundação SQL) e sprint-004 (5 features, núcleo do pipeline) são as mais pesadas, ambas complexity=high, 3 rounds.
- Escopo coeso e justificável; estimativas compatíveis. Sem recomendação de quebra.
- Status: ACEITO COMO ESTÁ

## 4. Conclusão
- Cobertura e Design Lock: aprovados.
- S1 e S2 (dependências faltantes de sprint-007): RESOLVIDOS.
- Sem achados pendentes. Plano de sprints APTO para aprovação.
