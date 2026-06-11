-- Migration: heartbeat (updated_at) em execucoes para auto-cura de orfa do
-- Effecti.
--
-- O pipeline do Effecti roda em background (EdgeRuntime.waitUntil no
-- ingestao-orquestrar/ingestao-coletar) e atualiza execucoes A CADA ITEM
-- (etapa_atual + contadores). Se o Edge Runtime morre no meio (timeout/OOM),
-- a execucao fica 'em_andamento' para sempre e o lock-por-fonte trava novas
-- coletas EM SILENCIO. Nomus tem runner_ts (heartbeat do runner) e Gmail tem
-- 'fechar-orfa'; o Effecti nao tinha nenhum sinal.
--
-- updated_at, bumpado a cada UPDATE pela fn_set_updated_at() ja existente
-- (20260606120400_triggers), vira o heartbeat: um pipeline VIVO toca a linha
-- a cada item; um MORTO para de tocar. O orquestrador trata execucao Effecti
-- ativa com updated_at velho (> teto) como orfa e a fecha como 'erro',
-- liberando o lock para o proximo ciclo.
--
-- Idempotente (if not exists / drop trigger if exists).

alter table public.execucoes
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists trg_set_updated_at_execucoes on public.execucoes;
create trigger trg_set_updated_at_execucoes
  before update on public.execucoes
  for each row execute function public.fn_set_updated_at();
