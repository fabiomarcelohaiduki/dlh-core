-- =====================================================================
-- Migration: execucoes REPLICA IDENTITY FULL (Realtime ao vivo com RLS)
--
-- A tela de execucoes assina mudancas via Supabase Realtime (postgres_changes
-- em public.execucoes), respeitando o RLS do usuario (policy is_conta_autorizada
-- no canal autenticado). O canal CONECTA (indicador "Tempo real ativo"), mas os
-- eventos UPDATE/DELETE NAO chegavam ao cliente: com REPLICA IDENTITY default
-- (so a PK), o evento nao carrega as colunas da linha, entao o motor de RLS do
-- Realtime nao consegue avaliar a policy e DESCARTA o evento. Os INSERT passavam
-- (carregam a linha toda), mas e o UPDATE que move a barra de progresso e os
-- contadores durante a coleta -> a tela ficava parada ("aguarde a conclusao").
--
-- FULL faz o WAL carregar a linha completa (old + new) nos UPDATE/DELETE, o RLS
-- avalia e o Realtime entrega. Custo: leve aumento de WAL por update (irrelevante
-- no volume de execucoes). Reversivel: REPLICA IDENTITY DEFAULT.
-- Idempotente. Aplicar via Node `pg` (SUPABASE_DB_URL).
-- =====================================================================

alter table public.execucoes replica identity full;
