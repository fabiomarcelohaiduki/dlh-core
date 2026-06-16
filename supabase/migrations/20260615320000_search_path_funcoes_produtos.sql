-- Fixa search_path nas funcoes public que estavam com search_path mutavel
-- (alerta "Function Search Path Mutable" do Supabase Security Advisor).
-- Todas referenciam apenas o schema public; pg_temp por ultimo previne
-- search_path hijacking via schema temporario. Nenhuma muda de corpo.

alter function public.fn_marcar_sku_erro(p_sku_id uuid) set search_path = public, pg_temp;
alter function public.fn_recalcular_sku(p_sku_id uuid) set search_path = public, pg_temp;
alter function public.fn_recalcular_skus_virada() set search_path = public, pg_temp;
alter function public.fn_set_texto_chars() set search_path = public, pg_temp;
alter function public.fn_set_updated_at() set search_path = public, pg_temp;
alter function public.fn_skus_no_escopo(p_nivel text, p_escopo uuid) set search_path = public, pg_temp;
alter function public.fn_trg_recalc_on_composicao() set search_path = public, pg_temp;
alter function public.fn_trg_recalc_on_custo_aquisicao() set search_path = public, pg_temp;
alter function public.fn_trg_recalc_on_insumo_preco() set search_path = public, pg_temp;
alter function public.fn_trg_recalc_on_parametro() set search_path = public, pg_temp;
alter function public.fn_trg_recalc_on_parametro_regional() set search_path = public, pg_temp;
alter function public.fn_trg_recalc_on_sku_tempo() set search_path = public, pg_temp;
alter function public.fn_upsert_preco(p_sku_id uuid, p_regiao text, p_patamar text, p_valor numeric, p_custo_base numeric, p_ifp numeric) set search_path = public, pg_temp;
