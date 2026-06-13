-- =====================================================================
-- Lote de producao no SKU + jornada (horas/dia) global.
--
-- produto_skus: tamanho_lote, tempo_lote, unidade_tempo ('hora'|'dia').
--   O Edge produtos-catalogo DERIVA tempo_producao (coluna existente) a
--   partir do lote no create/update:
--     tempo_producao = tempo_lote * fator(unidade) / tamanho_lote
--     fator: hora = 1 ; dia = horas_por_dia (global)
--   Lote incompleto => tempo_producao = null (sem mao de obra). O motor IFP
--   NAO muda (continua lendo tempo_producao) e o trigger de recalculo ja
--   dispara quando tempo_producao muda.
--
-- parametros_calculo: horas_por_dia (jornada). Usada SO no nivel global
--   (constante da empresa); editavel em Parametros.
--
-- Idempotente. Aplicado via Node pg (NAO `supabase db push`).
-- =====================================================================

alter table public.produto_skus
  add column if not exists tamanho_lote  numeric,
  add column if not exists tempo_lote    numeric,
  add column if not exists unidade_tempo text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'produto_skus_unidade_tempo_check'
  ) then
    alter table public.produto_skus
      add constraint produto_skus_unidade_tempo_check
      check (unidade_tempo is null or unidade_tempo in ('hora', 'dia'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'produto_skus_tamanho_lote_check'
  ) then
    alter table public.produto_skus
      add constraint produto_skus_tamanho_lote_check
      check (tamanho_lote is null or tamanho_lote > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'produto_skus_tempo_lote_check'
  ) then
    alter table public.produto_skus
      add constraint produto_skus_tempo_lote_check
      check (tempo_lote is null or tempo_lote >= 0);
  end if;
end $$;

alter table public.parametros_calculo
  add column if not exists horas_por_dia numeric;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'parametros_calculo_horas_por_dia_check'
  ) then
    alter table public.parametros_calculo
      add constraint parametros_calculo_horas_por_dia_check
      check (horas_por_dia is null or horas_por_dia > 0);
  end if;
end $$;

-- Jornada default (8h) no nivel global, editavel em Parametros.
update public.parametros_calculo
   set horas_por_dia = 8
 where nivel = 'global' and horas_por_dia is null;
