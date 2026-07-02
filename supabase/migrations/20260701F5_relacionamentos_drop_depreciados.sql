-- =====================================================================
-- Feature: Relacionamentos V2 - F5 (Limpeza zero-lixo, gate S6)
--
-- Migration de DROP dos artefatos legados JA SUPERADOS. Cada DROP usa
-- IF EXISTS, portanto e IDEMPOTENTE e REVERSIVEL no meio do caminho
-- (rodar de novo, ou parar apos qualquer statement, nunca quebra).
--
-- US-28 (provar zero-caller ANTES de dropar): TODOS os callers de codigo
-- ativo dos artefatos abaixo foram eliminados no mesmo sprint (validado
-- por grep; relatorio no SPEC_PROGRESS.md). So depois disso os DROPs sao
-- executados aqui.
--
-- ESCOPO EFETIVO NESTA MIGRATION
-- ------------------------------------------------------------------
-- [DROP] public.relacoes :: coluna legada `status`
--        (+ CHECK inline `relacoes_status_check` e indice parcial
--         `idx_relacoes_status` WHERE status='confirmado').
--
--   Por que agora e seguro (zero-caller US-28):
--     * A RPC de travessia public.relacoes_vizinhanca foi reescrita na F1
--       (20260701F1_relacionamentos_rpc_vizinhanca_sem_filtro_status.sql):
--       NAO filtra mais status='confirmado'; guia a UX por incorreta=false
--       + tipo_relacionamento. Nenhuma funcao/view ativa referencia mais
--       relacoes.status (funcao sql/plpgsql nao cria dependencia dura de
--       coluna; a checagem de views/policies deu 0).
--     * O backfill (_shared/relacionamentos-backfill.ts) faz UPSERT em
--       relacoes SEM a coluna status no payload (origem/destino/relacao/
--       metodo/chave/confianca), logo nao depende do default nem da coluna.
--     * grep por status='confirmado' em codigo ativo (ts/tsx) = 0.
--   Ordem: DROP INDEX -> DROP CONSTRAINT -> DROP COLUMN (cada IF EXISTS),
--   de modo que parar no meio nunca deixa o schema inconsistente.
--
-- [DROP] public.config_relacionamentos :: coluna legada `cap_panorama`
--
--   Por que agora e seguro (zero-caller US-28): a precedencia efetiva do
--   cap passou a ser `cap_por_grafo ?? 200` em TODOS os leitores ativos
--   (relacionamentos-buscar-split, relacionamentos-panorama,
--   relacionamentos-config, relacionamentos-regras-semanticas + tipos/zod
--   do front). Nenhum SELECT/UPDATE/insert-default referencia mais
--   cap_panorama. grep por cap_panorama em codigo ativo (ts/tsx) = 0.
--
-- [DROP] public.vinculos_inferidos_lia :: CHECK legada inline
--        `vinculos_inferidos_lia_status_check`
--        (status in ('proposta','ativa','rejeitada')).
--
--   Por que agora e seguro: a F4 (20260701F4_relacionamentos_enum_
--   revisao_leve.sql) ja adicionou a CHECK coexistente
--   `vinculos_inferidos_lia_status_revisao_leve_check`, que e a UNIAO do
--   vocabulario legado com o novo:
--       ('proposta','ativa','rejeitada','rascunho','ativo','descartado')
--   Enquanto as duas CHECKs coexistiam, a restricao efetiva era a
--   INTERSECAO (so o vocabulario antigo passava). Ao dropar a legada
--   aqui, a CHECK da F4 (superset) passa a ser a unica guarda efetiva e
--   LIBERA o vocabulario novo (rascunho/ativo/descartado) SEM migration
--   adicional. Nenhuma escrita existente quebra: todo valor antes valido
--   continua valido sob o superset. O vocabulario legado 'proposta'/
--   'ativa'/'rejeitada' ja nao aparece em codigo ativo (grep = 0); os
--   valores porventura ainda gravados continuam validos sob o superset.
--
-- NAO REMOVE audit_log NEM policies RLS. Enum logico continua via
-- text + CHECK (PRD D.7). Idempotente e reversivel via IF EXISTS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- relacoes.status (coluna legada + CHECK + indice parcial)
-- ---------------------------------------------------------------------
drop index if exists public.idx_relacoes_status;

alter table public.relacoes
  drop constraint if exists relacoes_status_check;

alter table public.relacoes
  drop column if exists status;

-- ---------------------------------------------------------------------
-- config_relacionamentos.cap_panorama (coluna legada; superada por
-- cap_por_grafo)
-- ---------------------------------------------------------------------
alter table public.config_relacionamentos
  drop column if exists cap_panorama;

-- ---------------------------------------------------------------------
-- vinculos_inferidos_lia :: CHECK legada (proposta/ativa/rejeitada)
-- ---------------------------------------------------------------------
alter table public.vinculos_inferidos_lia
  drop constraint if exists vinculos_inferidos_lia_status_check;

-- Nota: a guarda efetiva de status em vinculos_inferidos_lia passa a ser
-- a CHECK da F4 (`vinculos_inferidos_lia_status_revisao_leve_check`), que
-- permite o superset legado+novo. Rollback: readicionar a CHECK legada
--   alter table public.vinculos_inferidos_lia
--     add constraint vinculos_inferidos_lia_status_check
--     check (status in ('proposta','ativa','rejeitada'));
-- so e possivel se nao houver linhas ja migradas para o vocabulario novo.
