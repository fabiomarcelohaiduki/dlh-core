-- =====================================================================
-- Migration: Motor de calculo IFP (markup POR DENTRO) - metodo real DLH
--
--   Substitui a formula de markup POR FORA (multiplicativa encadeada) da
--   migration 20260612110000 pela formula real usada nas planilhas de
--   Engenharia de Custos da DLH:
--
--       IFP   = 1 - (impostos + frete + despesas + lucro)
--       Preco = Custo Variavel Tecnico / IFP
--
--   Patamares (substituem CIF/FOB):
--     - FOB        : IFP sem frete           -> custo / (1-(i+d+La))
--     - CIF_ALVO   : IFP com frete + lucro alvo
--     - CIF_MINIMO : IFP com frete + lucro minimo (piso de negociacao)
--
--   Frete e POR REGIAO: parametro_regional.percentual (fallback frete_pct
--   escalar). FOB independe de regiao (gravado igual nas 5 p/ uniformidade
--   da tabela 5 regioes x 3 patamares = 15 linhas/SKU).
--
--   Conferencia (FLANELA 30X40, planilha):
--     Custo Variavel 0,99 ; i=13 d=10 La=15 frete medio=15
--     CIF medio  0,99/(1-(0,13+0,15+0,10+0,15)) = 0,99/0,47 = 2,11  OK
--     FOB        0,99/(1-(0,13+0,10+0,15))       = 0,99/0,62 = 1,60  OK
--
--   Migration ADITIVA e IDEMPOTENTE.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Lucro minimo configuravel (CIF Minimo) - mesmo padrao de heranca
--    PRODUTO -> LINHA -> GLOBAL dos demais escalares.
-- ---------------------------------------------------------------------
alter table public.parametros_calculo
  add column if not exists lucro_minimo_pct numeric;

-- ---------------------------------------------------------------------
-- 2) Patamar: CIF/FOB -> CIF_ALVO/CIF_MINIMO/FOB.
--    Linhas de preco sao 100% DERIVADAS (regeneradas pelo motor), entao
--    descartar legado 'CIF' e seguro; 'FOB' permanece valido.
-- ---------------------------------------------------------------------
delete from public.sku_precos_calculados where patamar = 'CIF';

alter table public.sku_precos_calculados
  drop constraint if exists sku_precos_calculados_patamar_check;
alter table public.sku_precos_calculados
  add constraint sku_precos_calculados_patamar_check
  check (patamar in ('CIF_ALVO', 'CIF_MINIMO', 'FOB'));

-- ---------------------------------------------------------------------
-- 3) Motor IFP. Mesma assinatura/contrato de fn_recalcular_sku:
--    triggers e o fallback manual seguem inalterados.
-- ---------------------------------------------------------------------
create or replace function public.fn_recalcular_sku(p_sku_id uuid)
returns text
language plpgsql
as $$
declare
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

  -- 3) Custo Variavel Tecnico por tipo_origem.
  if v_tipo_origem = 'comprado' then
    select sca.custo into v_custo_aquisicao
    from public.sku_custo_aquisicao sca
    where sca.sku_id = p_sku_id
      and (sca.vigencia_fim is null or sca.vigencia_fim >= current_date)
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
          and (ip.vigencia_fim is null or ip.vigencia_fim >= current_date));
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
        and (ip.vigencia_fim is null or ip.vigencia_fim >= current_date)
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

-- ---------------------------------------------------------------------
-- Helper: upsert de 1 linha de preco preservando valor_anterior.
-- ---------------------------------------------------------------------
create or replace function public.fn_upsert_preco(
  p_sku_id uuid, p_regiao text, p_patamar text,
  p_valor numeric, p_custo_base numeric, p_ifp numeric
)
returns void
language sql
as $$
  insert into public.sku_precos_calculados
    (sku_id, regiao, patamar, valor, custo_base, ifp, estado, calculado_em, updated_at)
  values
    (p_sku_id, p_regiao, p_patamar, p_valor, p_custo_base, p_ifp, 'vigente', now(), now())
  on conflict (sku_id, regiao, patamar) do update
    set valor_anterior = sku_precos_calculados.valor,
        valor          = excluded.valor,
        custo_base     = excluded.custo_base,
        ifp            = excluded.ifp,
        estado         = 'vigente',
        calculado_em   = excluded.calculado_em,
        updated_at     = now();
$$;
