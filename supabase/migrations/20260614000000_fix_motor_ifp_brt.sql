-- =====================================================================
-- Migration: corrige regressao do motor IFP
-- =====================================================================
-- A migration 20260613240000_cron_virada_vigencia.sql reintroduziu, por
-- copia indevida, o corpo ANTIGO de fn_recalcular_sku (markup POR FORA,
-- patamares 'CIF'/'FOB'). Mas a constraint sku_precos_calculados_patamar_check
-- ja havia sido migrada para ('CIF_ALVO','CIF_MINIMO','FOB') pela
-- 20260612130000_produtos_motor_ifp.sql. Resultado: todo recalculo de SKU
-- (disparado ao inserir custo de aquisicao / preco de insumo) falhava com
-- 23514 (patamar 'CIF' viola o check), virando 500 no Edge e o erro generico
-- "Nao foi possivel adicionar o custo" na tela de Custo dos SKUs.
--
-- Esta migration restaura o motor IFP (Preco = Custo Variavel / IFP, com
-- patamares CIF_ALVO/CIF_MINIMO/FOB) E preserva as duas melhorias da
-- 20260613240000: "hoje" resolvido em BRT (America/Sao_Paulo) e o guard
-- vigencia_inicio <= hoje (faixa agendada nao entra antes da hora).
--
-- Idempotente (create or replace).
-- =====================================================================

create or replace function public.fn_recalcular_sku(p_sku_id uuid)
returns text
language plpgsql
as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;

  v_tipo_origem    text;
  v_produto_id     uuid;
  v_linha_id       uuid;
  v_tempo_producao numeric;

  -- percentuais escalares resolvidos PRODUTO -> LINHA -> GLOBAL (como fracao)
  v_impostos numeric;
  v_frete    numeric;   -- frete medio (fallback do regional)
  v_despesas numeric;
  v_lucro    numeric;   -- lucro alvo
  v_lucro_min numeric;  -- lucro minimo (CIF Minimo)
  v_taxa_horaria numeric;

  v_custo_variavel  numeric;
  v_mao_de_obra     numeric;
  v_custo_aquisicao numeric;
  v_comp_count      integer;
  v_sem_preco_count integer;

  v_regioes text[] := array['S','SE','CO','NE','N'];
  v_regiao  text;
  v_frete_r numeric;

  -- FOB independe de regiao: calculado uma vez.
  v_ifp_fob numeric;
  v_preco_fob numeric;

  v_ifp_alvo numeric;
  v_ifp_min  numeric;
  v_preco_alvo numeric;
  v_preco_min  numeric;
begin
  -- 1) SKU + linha.
  select ps.tipo_origem, ps.produto_id, ps.tempo_producao, p.linha_id
    into v_tipo_origem, v_produto_id, v_tempo_producao, v_linha_id
  from public.produto_skus ps
  join public.produtos p on p.id = ps.produto_id
  where ps.id = p_sku_id;

  if not found then
    return null;
  end if;

  -- 2) Percentuais (em fracao: 13 => 0.13). COALESCE 3 niveis.
  v_impostos := coalesce(
    (select impostos_pct from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select impostos_pct from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select impostos_pct from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0) / 100;
  v_frete := coalesce(
    (select frete_pct from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select frete_pct from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select frete_pct from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0) / 100;
  v_despesas := coalesce(
    (select despesas_pct from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select despesas_pct from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select despesas_pct from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0) / 100;
  v_lucro := coalesce(
    (select lucro_pct from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select lucro_pct from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select lucro_pct from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0) / 100;
  v_lucro_min := coalesce(
    (select lucro_minimo_pct from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select lucro_minimo_pct from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select lucro_minimo_pct from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0) / 100;
  v_taxa_horaria := coalesce(
    (select taxa_horaria from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select taxa_horaria from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select taxa_horaria from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0);

  -- 3) Custo Variavel Tecnico por tipo_origem. Vigente: inicio ja chegou
  --    (<= hoje BRT) e fim nulo ou >= hoje; maior vigencia_inicio vence,
  --    desempatando por created_at mais recente.
  if v_tipo_origem = 'comprado' then
    select sca.custo into v_custo_aquisicao
    from public.sku_custo_aquisicao sca
    where sca.sku_id = p_sku_id
      and sca.vigencia_inicio <= v_hoje
      and (sca.vigencia_fim is null or sca.vigencia_fim >= v_hoje)
    order by sca.vigencia_inicio desc, sca.created_at desc
    limit 1;

    if v_custo_aquisicao is null then
      perform public.fn_marcar_sku_erro(p_sku_id);
      return 'erro';
    end if;
    v_custo_variavel := round(v_custo_aquisicao, 4);
  else
    select count(*) into v_comp_count
    from public.sku_composicao where sku_id = p_sku_id;
    if v_comp_count = 0 then
      perform public.fn_marcar_sku_erro(p_sku_id);
      return 'erro';
    end if;

    select count(*) into v_sem_preco_count
    from public.sku_composicao sc
    where sc.sku_id = p_sku_id
      and not exists (
        select 1 from public.insumo_precos ip
        where ip.insumo_id = sc.insumo_id
          and ip.vigencia_inicio <= v_hoje
          and (ip.vigencia_fim is null or ip.vigencia_fim >= v_hoje));
    if v_sem_preco_count > 0 then
      perform public.fn_marcar_sku_erro(p_sku_id);
      return 'erro';
    end if;

    select coalesce(sum(sc.quantidade * pv.preco), 0)
      into v_custo_variavel
    from public.sku_composicao sc
    cross join lateral (
      select ip.preco from public.insumo_precos ip
      where ip.insumo_id = sc.insumo_id
        and ip.vigencia_inicio <= v_hoje
        and (ip.vigencia_fim is null or ip.vigencia_fim >= v_hoje)
      order by ip.vigencia_inicio desc, ip.created_at desc
      limit 1) pv
    where sc.sku_id = p_sku_id;

    v_mao_de_obra := coalesce(v_tempo_producao, 0) * coalesce(v_taxa_horaria, 0);
    v_custo_variavel := round(v_custo_variavel + v_mao_de_obra, 4);
  end if;

  -- 4) FOB (sem frete, independe de regiao). IFP <= 0 => erro do SKU.
  v_ifp_fob := 1 - (v_impostos + v_despesas + v_lucro);
  if v_ifp_fob <= 0 then
    perform public.fn_marcar_sku_erro(p_sku_id);
    return 'erro';
  end if;
  v_preco_fob := round(v_custo_variavel / v_ifp_fob, 2);

  -- 5) Por regiao: CIF_ALVO e CIF_MINIMO usam frete da regiao.
  foreach v_regiao in array v_regioes loop
    v_frete_r := coalesce(
      (select percentual from public.parametro_regional
         where nivel = 'produto' and escopo_id = v_produto_id and regiao = v_regiao),
      (select percentual from public.parametro_regional
         where nivel = 'linha'   and escopo_id = v_linha_id   and regiao = v_regiao),
      (select percentual from public.parametro_regional
         where nivel = 'global'  and escopo_id is null        and regiao = v_regiao),
      v_frete * 100   -- fallback: frete medio escalar
    ) / 100;

    v_ifp_alvo := 1 - (v_impostos + v_frete_r + v_despesas + v_lucro);
    v_ifp_min  := 1 - (v_impostos + v_frete_r + v_despesas + v_lucro_min);

    if v_ifp_alvo <= 0 or v_ifp_min <= 0 then
      perform public.fn_marcar_sku_erro(p_sku_id);
      return 'erro';
    end if;

    v_preco_alvo := round(v_custo_variavel / v_ifp_alvo, 2);
    v_preco_min  := round(v_custo_variavel / v_ifp_min, 2);

    perform public.fn_upsert_preco(p_sku_id, v_regiao, 'CIF_ALVO',   v_preco_alvo, v_custo_variavel, round(v_ifp_alvo, 4));
    perform public.fn_upsert_preco(p_sku_id, v_regiao, 'CIF_MINIMO', v_preco_min,  v_custo_variavel, round(v_ifp_min, 4));
    perform public.fn_upsert_preco(p_sku_id, v_regiao, 'FOB',        v_preco_fob,  v_custo_variavel, round(v_ifp_fob, 4));
  end loop;

  update public.produto_skus
     set estado_calculo = 'vigente', updated_at = now()
   where id = p_sku_id;

  return 'vigente';
end;
$$;
