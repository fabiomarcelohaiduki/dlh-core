-- =====================================================================
-- Triagem — janela de datas CONFIGURAVEL.
--
-- Permite restringir QUAIS avisos entram na fila de triagem com base na
-- data de abertura dos lances (avisos.data_final, gravada em UTC real):
--
--   triar_apenas_futuros   -> quando true, ignora avisos cuja abertura ja
--                             passou (data_final < now()).
--   triagem_horizonte_dias -> quando > 0, so triagem avisos que abrem dentro
--                             de N dias a partir de agora (data_final <= now()
--                             + N dias). 0 = sem teto.
--
-- Avisos com data_final NULL SEMPRE entram (nao ha como avaliar a janela).
-- Defaults preservam o comportamento atual (sem filtro de data).
-- Singleton config_automacao; aplicado nos DOIS gates da fila (IA + cockpit).
-- =====================================================================

alter table public.config_automacao
  add column if not exists triar_apenas_futuros boolean not null default false;

alter table public.config_automacao
  add column if not exists triagem_horizonte_dias int not null default 0
    check (triagem_horizonte_dias >= 0);

-- Teto determinístico no banco (espelha o cap do zod/UI = 3650 dias / ~10 anos).
-- Fail-fast contra escrita direta no banco (scripts pg). Constraint nomeada =
-- idempotente via guard no catalogo.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'config_automacao_triagem_horizonte_dias_teto'
      and conrelid = 'public.config_automacao'::regclass
  ) then
    alter table public.config_automacao
      add constraint config_automacao_triagem_horizonte_dias_teto
        check (triagem_horizonte_dias <= 3650);
  end if;
end $$;

comment on column public.config_automacao.triar_apenas_futuros is
  'Quando true, exclui da fila de triagem avisos cuja abertura (data_final) ja passou. Avisos com data_final NULL entram sempre.';

comment on column public.config_automacao.triagem_horizonte_dias is
  'Teto de dias a partir de agora para a abertura (data_final) do aviso entrar na fila. 0 = sem teto. Avisos com data_final NULL entram sempre.';
