# Pipeline de documentos (camada 1 / Tika) — estado real

> Relatório de mapeamento + limpeza de erros. Data: 2026-06-11.
> Substitui a nota desatualizada de 2026-06-08 ("PRÓXIMO: migration config_extracao
> + extrator.mjs + workflow + validar 1 anexo"). **Tudo isso já existe e já rodou
> em escala** — 37k vínculos processados, 28.9k documentos com texto extraído.

## 1. O que está PRONTO (camada 1 — extração de texto)

Pipeline agnóstico de fonte, construído e rodado em produção:

- **`extrator.mjs`** (runner Node) — Tika `full` (OCR Tesseract) em `localhost:9998`,
  desempacota ZIP, decodifica texto puro/markup no Node, gera `sha256Bytes` +
  `hashTextoNormalizado` (dedup). Zero LLM, determinístico.
- **`documentos-descobrir`** (Edge) — enfileira `documento_vinculos` (status
  `pendente`) por fonte (nomus/effecti/drive/gmail). RPC SQL por fonte, idempotente.
- **`documentos-ingerir`** (Edge) — PUSH do runner. Dono da persistência: dedup
  global por `hash_texto_normalizado` (fallback `sha256_bytes`), grava `documentos`,
  indexa (quem chega 1º extrai; o resto só LINKA = `herdado`).
- **`extrair-anexos.yml`** — Tika como service container efêmero; `workflow_dispatch`;
  `concurrency: cancel-in-progress:false` (novo run enfileira atrás).
- **`extrair-anexos.mjs`** — orquestrador: pede pendentes + config, obtém bytes por
  adaptador (Nomus base64 / Effecti URL / Drive API / Gmail anexo), extrai, dá push.
- **Migrations**: `config_extracao`, `documentos`, `config_extracao_fontes`,
  `agendamento_extracao`, `disparar_extracao`.

### Números (banco, 2026-06-11)

| Métrica | Valor |
|---|---|
| Vínculos totais | ~37.3k |
| — extraídos | 28.970 |
| — herdados (dedup OK) | 5.272 |
| — pendentes | 2.655 |
| — erro | 394 (era 629 antes da limpeza) |
| Documentos com texto | 28.935 |
| — **indexados** | **0** |
| — via OCR | 1.504 |
| Vínculos por fonte | Gmail 22.899 · Nomus 10.874 · Effecti 3.480 · Drive 38 |
| config_extracao | ocr=auto, idioma=por+eng, fontes/extensões=todas, lote=10 |

## 2. Limpeza de erros (executada hoje)

629 erros categorizados por recuperabilidade:

| Categoria | Qtd | Ação |
|---|---|---|
| `filename_bytestring` (header U+FFFD) | 119 | **CORRIGIDO** (commit `e752224`) + reset |
| Transitórios (fetch_failed/tika_timeout/tika_net/tika_http) | 116 | **RESET** para `pendente` |
| RAR/7z não suportado | 69 | **ADIADO** (precisa `node-7z`+`7zip-bin`) |
| Definitivos (anexo/msg sumiu da origem) | ~325 | **ACEITAR** (nomus_404 296, Gmail 404/400 ~20, etc.) |

- **Fix**: `extrator.mjs` → `nomeSeguroHeader()` troca codepoints >255 por `_` e
  escapa aspas/controle antes do `Content-Disposition` (ByteString do fetch quebrava).
- **Reset**: 235 vínculos (119+116) → `pendente`, erro limpo. Erros 629→394.
- **Drenagem**: workflow disparado (run 27322115244), enfileirado atrás de um run
  de 5h37m; vai pegar o `extrator.mjs` já corrigido.

## 3. O que falta (frentes abertas, por valor)

1. **Indexação ZERADA — gargalo nº1.** 0 de 28.935 documentos indexados
   (`status_indexacao='pendente'`, `EMBEDDINGS_ENDPOINT` vazio). Sem isso o cérebro
   tem 28k textos mas **nenhuma busca semântica**. Bloqueio: precisa de endpoint
   bge-m3 rodando (provisionar infra ou ligar config?). Depois reindexar tudo.
2. **Camada 2 (estruturação LLM dos 12 campos)** — não existe; só o gancho
   `tipo_documento`. Próximo grande bloco. Depende de classificar tipo do anexo.
3. **RAR/7z (69 docs)** — add `node-7z`+`7zip-bin` ao runner.
4. **~325 definitivos** — aceitar como erro real (origem perdeu o arquivo).

## 4. Próximo passo concreto

Validar a drenagem após o run rodar (conferir os 235 saírem de `pendente`).
Depois decidir a frente nº1 (indexação): **confirmar se há endpoint bge-m3
disponível** — define se é "ligar config" ou "subir infra".
