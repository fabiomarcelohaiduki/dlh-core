-- =====================================================================
-- Migration: recalculo de SKU tambem ao REMOVER faixa de preco
-- =====================================================================
-- Contexto: a tela de Materiais passa a permitir EXCLUIR uma faixa de
-- insumo_precos. Remover a faixa vigente muda o preco efetivo do insumo,
-- mas o trigger original (20260612110000) so disparava em INSERT/UPDATE,
-- deixando os SKUs com custo defasado apos um DELETE.
--
-- Correcao: a fn passa a resolver o insumo afetado a partir de OLD em
-- DELETE (e de NEW nas demais operacoes) e o trigger cobre tambem DELETE.
-- Idempotente (create or replace + drop trigger if exists).
-- =====================================================================

create or replace function public.fn_trg_recalc_on_insumo_preco()
returns trigger
language plpgsql
as $$
declare
  r record;
  v_insumo_id uuid := case when tg_op = 'DELETE' then old.insumo_id else new.insumo_id end;
begin
  for r in
    select distinct sc.sku_id
    from public.sku_composicao sc
    where sc.insumo_id = v_insumo_id
       or (tg_op = 'UPDATE' and sc.insumo_id = old.insumo_id)
  loop
    perform public.fn_recalcular_sku(r.sku_id);
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_recalc_sku_on_insumo_preco on public.insumo_precos;
create trigger trg_recalc_sku_on_insumo_preco
  after insert or update or delete on public.insumo_precos
  for each row execute function public.fn_trg_recalc_on_insumo_preco();
