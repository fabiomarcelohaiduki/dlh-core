-- =====================================================================
-- Feature Nomus Processos (eficiencia da coleta — watermark por id)
-- Migration: funcao read-only que devolve o MAIOR nomus_id ja persistido,
-- comparado NUMERICAMENTE (DD 2026-06-07).
--
-- MOTIVO: a coluna nomus_processos.nomus_id e TEXT (fiel ao payload do Nomus,
-- 20260606140000_nomus_schema.sql:24). Os ids sao sequenciais de comprimento
-- variavel (desde "1"), entao MAX(nomus_id) LEXICOGRAFICO ja erra hoje
-- ("9999" > "29669"). O coletor de nuvem usa este MAX como marca d'agua para
-- so puxar processos NOVOS (id > marca) em vez de varrer todas as paginas a
-- cada ciclo. Aqui o MAX e calculado em BIGINT, ignorando ids nao-numericos.
--
-- Marca d'agua GLOBAL (sem filtro de tipo): representa o id mais novo que ja
-- esta no banco, qualquer que seja o tipo persistido — exatamente o ponto de
-- parada do coletor (varre DESC ate alcancar territorio conhecido).
--
-- Alteracao ADITIVA e idempotente. Nenhuma coluna/constraint e tocada.
-- =====================================================================

create or replace function public.nomus_max_nomus_id()
returns bigint
language sql
stable
security definer
set search_path = public, extensions
as $$
  select max((nomus_id)::bigint)
  from public.nomus_processos
  where nomus_id ~ '^[0-9]+$';
$$;

-- So a borda (service_role) consulta a marca d'agua; bloqueia chamada direta
-- por anon/authenticated (espelha o padrao de aplicar_agendamento).
revoke all on function public.nomus_max_nomus_id() from public, anon, authenticated;
grant execute on function public.nomus_max_nomus_id() to service_role;
