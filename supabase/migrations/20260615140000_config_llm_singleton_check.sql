-- =====================================================================
-- config_llm: travas DETERMINISTICAS no banco
--   (1) Singleton real: indice unico sobre expressao constante garante
--       no maximo 1 linha (resolve M3/M4 — corrida no PUT nao cria 2a linha).
--   (2) CHECK de faixa para descricao_max_palavras (resolve B1 — a regra
--       10..300 deixa de existir so no zod/UI e passa a ser garantida no BD).
-- Idempotente: pode reaplicar sem efeito colateral.
-- =====================================================================

create unique index if not exists config_llm_singleton
  on public.config_llm ((true));

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'config_llm_max_palavras_range'
  ) then
    alter table public.config_llm
      add constraint config_llm_max_palavras_range
      check (descricao_max_palavras between 10 and 300);
  end if;
end$$;
