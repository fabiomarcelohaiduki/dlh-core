-- =====================================================================
-- avisos.conteudo_hash — deteccao de mudanca real do Effecti
--
-- Antes a coleta do Effecti fazia upsert CEGO (ignoreDuplicates:false) e
-- contava como 'alterado' TODO aviso re-coletado (effecti_id ja existente),
-- mesmo sem mudanca de conteudo -> ALTERADOS inflado (ex.: 402 alterados
-- com 0 novos numa janela ja coletada) + escrita desnecessaria a cada ciclo.
--
-- Esta coluna guarda o hash (FNV-1a 64) do payload_bruto. A coleta passa a
-- so reescrever/contar 'alterado' quando o hash muda (espelha o Nomus, que
-- ja compara hash via _shared/hash.ts).
--
-- Legado: linhas antigas ficam com conteudo_hash NULL. A 1a coleta apos o
-- deploy popula o hash e conta como IGNORADO (nao como alterado), evitando
-- um falso pico de 'alterados' na estabilizacao.
-- =====================================================================

alter table public.avisos
  add column if not exists conteudo_hash text;
