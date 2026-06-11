-- Migration: rede de seguranca no nivel do banco para o anti-duplo-disparo.
--
-- O lock-por-fonte hoje e check-then-insert no codigo (SELECT status=
-- 'em_andamento' seguido de INSERT). Duas requisicoes concorrentes podem
-- ambas ler zero linhas e ambas inserir uma execucao 'em_andamento' para a
-- mesma fonte (TOCTOU). As camadas de cima (409 no dispatch, GitHub API)
-- estreitam a janela mas nao a fecham; o unico ponto serializavel e o banco.
--
-- Indice unico parcial: garante NO MAXIMO 1 execucao 'em_andamento' por
-- (fonte_id, recurso). Effecti/Gmail tem recurso NULL -> colapsa via
-- coalesce(recurso,'') em 1 ativa por fonte. Nomus grava recurso (ex.:
-- 'processos') -> 1 ativa por fonte+recurso, preservando paralelismo entre
-- modulos. Execucoes concorrentes na corrida falham com 23505 e o Edge
-- traduz para 409 (ja_em_andamento).
--
-- Idempotente (if not exists). Banco verificado sem duplicatas ativas antes
-- de aplicar (0 execucoes em_andamento), entao a criacao nao bloqueia.

create unique index if not exists uidx_execucoes_uma_ativa_por_fonte
  on public.execucoes (fonte_id, (coalesce(recurso, '')))
  where status = 'em_andamento';
