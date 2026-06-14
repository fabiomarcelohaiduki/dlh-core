-- =====================================================================
-- Migration: data de vigencia em BRT + cron diario de virada de vigencia
-- =====================================================================
-- Parte 1 — TIMEZONE: o motor usava current_date (UTC). Entre 00:00 e 03:00
-- BRT o current_date (UTC) ainda apontava o dia anterior, divergindo da tela
-- (que usa data LOCAL). A fn_recalcular_sku passa a resolver o "hoje" como
-- (now() at time zone 'America/Sao_Paulo')::date, ficando coerente com a UI.
--
-- Parte 2 — CRON: o recalculo e sincrono no trigger de escrita; um preco
-- AGENDADO (inicio futuro) nao entrava sozinho na virada da data. Esta
-- migration cria fn_recalcular_skus_virada(), que recalcula apenas os SKUs
-- que cruzam uma FRONTEIRA de vigencia no dia (faixa que entra hoje ou que
-- venceu ontem), e a agenda no pg_cron para rodar logo apos a meia-noite BRT.
--
-- Recalcular um SKU que nao mudou recomputa o mesmo valor (idempotente), e a
-- selecao por fronteira evita varrer o catalogo inteiro. Regra critica
-- DETERMINISTICA no banco (pg_cron + SQL), nunca na IA.
--
-- Idempotente (create or replace; unschedule condicional antes do schedule).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Parte 1: motor com "hoje" em BRT (substitui 20260613230000).
-- ---------------------------------------------------------------------
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

  -- parametros escalares resolvidos PRODUTO -> LINHA -> GLOBAL
  v_impostos_pct numeric;
  v_frete_pct    numeric;
  v_despesas_pct numeric;
  v_lucro_pct    numeric;
  v_taxa_horaria numeric;

  v_custo_variavel numeric;   -- Custo Variavel (4 casas)
  v_mao_de_obra    numeric;
  v_custo_aquisicao numeric;
  v_comp_count      integer;
  v_sem_preco_count integer;

  v_regioes  text[] := array['S','SE','CO','NE','N'];
  v_regiao   text;
  v_regional_pct numeric;

  v_pos_impostos numeric;
  v_base         numeric;
  v_valor_cif    numeric;
  v_valor_fob    numeric;
begin
  -- 1) Carrega o SKU + linha do produto.
  select ps.tipo_origem, ps.produto_id, ps.tempo_producao, p.linha_id
    into v_tipo_origem, v_produto_id, v_tempo_producao, v_linha_id
  from public.produto_skus ps
  join public.produtos p on p.id = ps.produto_id
  where ps.id = p_sku_id;

  if not found then
    return null;  -- SKU inexistente: nada a recalcular.
  end if;

  -- 2) Resolve os percentuais escalares por COALESCE 3 niveis (independentes).
  v_impostos_pct := coalesce(
    (select impostos_pct from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select impostos_pct from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select impostos_pct from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0
  );
  v_frete_pct := coalesce(
    (select frete_pct from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select frete_pct from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select frete_pct from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0
  );
  v_despesas_pct := coalesce(
    (select despesas_pct from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select despesas_pct from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select despesas_pct from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0
  );
  v_lucro_pct := coalesce(
    (select lucro_pct from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select lucro_pct from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select lucro_pct from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0
  );
  v_taxa_horaria := coalesce(
    (select taxa_horaria from public.parametros_calculo where nivel = 'produto' and escopo_id = v_produto_id),
    (select taxa_horaria from public.parametros_calculo where nivel = 'linha'   and escopo_id = v_linha_id),
    (select taxa_horaria from public.parametros_calculo where nivel = 'global'  and escopo_id is null),
    0
  );

  -- 3) Obtem o Custo Variavel conforme tipo_origem; valida entradas essenciais.
  if v_tipo_origem = 'comprado' then
    -- Custo Variavel = custo de aquisicao vigente (ignora BOM/tempo).
    -- Vigente: inicio ja chegou (<= hoje) e fim nulo ou >= hoje; o maior
    -- vigencia_inicio vence, desempatando por created_at mais recente.
    select sca.custo
      into v_custo_aquisicao
    from public.sku_custo_aquisicao sca
    where sca.sku_id = p_sku_id
      and sca.vigencia_inicio <= v_hoje
      and (sca.vigencia_fim is null or sca.vigencia_fim >= v_hoje)
    order by sca.vigencia_inicio desc, sca.created_at desc
    limit 1;

    if v_custo_aquisicao is null then
      -- Entrada essencial faltante: 'sem custo de aquisicao vigente'.
      perform public.fn_marcar_sku_erro(p_sku_id);
      return 'erro';
    end if;

    v_custo_variavel := round(v_custo_aquisicao, 4);

  else
    -- fabricado: Custo Variavel = soma(quantidade * preco_vigente) da BOM
    --            + mao de obra (tempo_producao * taxa_horaria).
    select count(*) into v_comp_count
    from public.sku_composicao
    where sku_id = p_sku_id;

    if v_comp_count = 0 then
      -- Composicao vazia -> erro, sem gravar valor.
      perform public.fn_marcar_sku_erro(p_sku_id);
      return 'erro';
    end if;

    -- Algum insumo da BOM sem preco vigente -> erro.
    select count(*) into v_sem_preco_count
    from public.sku_composicao sc
    where sc.sku_id = p_sku_id
      and not exists (
        select 1
        from public.insumo_precos ip
        where ip.insumo_id = sc.insumo_id
          and ip.vigencia_inicio <= v_hoje
          and (ip.vigencia_fim is null or ip.vigencia_fim >= v_hoje)
      );

    if v_sem_preco_count > 0 then
      perform public.fn_marcar_sku_erro(p_sku_id);
      return 'erro';
    end if;

    -- Soma quantidade * preco vigente de cada insumo da BOM.
    select coalesce(sum(sc.quantidade * pv.preco), 0)
      into v_custo_variavel
    from public.sku_composicao sc
    cross join lateral (
      select ip.preco
      from public.insumo_precos ip
      where ip.insumo_id = sc.insumo_id
        and ip.vigencia_inicio <= v_hoje
        and (ip.vigencia_fim is null or ip.vigencia_fim >= v_hoje)
      order by ip.vigencia_inicio desc, ip.created_at desc
      limit 1
    ) pv
    where sc.sku_id = p_sku_id;

    -- Mao de obra: tempo_producao nulo => MOD zero (calculo prossegue).
    v_mao_de_obra := coalesce(v_tempo_producao, 0) * coalesce(v_taxa_horaria, 0);

    v_custo_variavel := round(v_custo_variavel + v_mao_de_obra, 4);
  end if;

  -- 4) Encadeamento de percentuais (estrutura fixa da SPEC), precisao 4 casas.
  --    Custo Variavel -> impostos -> [frete (so CIF)] -> despesas -> lucro
  --    -> ajuste regional -> CIF/FOB.
  v_pos_impostos := round(v_custo_variavel * (1 + v_impostos_pct / 100), 4);

  foreach v_regiao in array v_regioes loop
    -- Vetor regional resolvido por regiao (PRODUTO -> LINHA -> GLOBAL).
    v_regional_pct := coalesce(
      (select percentual from public.parametro_regional
         where nivel = 'produto' and escopo_id = v_produto_id and regiao = v_regiao),
      (select percentual from public.parametro_regional
         where nivel = 'linha'   and escopo_id = v_linha_id   and regiao = v_regiao),
      (select percentual from public.parametro_regional
         where nivel = 'global'  and escopo_id is null        and regiao = v_regiao),
      0
    );

    -- CIF: com frete.
    v_base := round(v_pos_impostos * (1 + v_frete_pct    / 100), 4);
    v_base := round(v_base         * (1 + v_despesas_pct / 100), 4);
    v_base := round(v_base         * (1 + v_lucro_pct    / 100), 4);
    v_base := round(v_base         * (1 + v_regional_pct / 100), 4);
    v_valor_cif := round(v_base, 2);  -- HALF_UP (numeric, valor >= 0)

    -- FOB: sem frete.
    v_base := round(v_pos_impostos * (1 + v_despesas_pct / 100), 4);
    v_base := round(v_base         * (1 + v_lucro_pct    / 100), 4);
    v_base := round(v_base         * (1 + v_regional_pct / 100), 4);
    v_valor_fob := round(v_base, 2);

    -- Regrava CIF preservando valor_anterior.
    insert into public.sku_precos_calculados
      (sku_id, regiao, patamar, valor, custo_base, estado, calculado_em, updated_at)
    values
      (p_sku_id, v_regiao, 'CIF', v_valor_cif, v_custo_variavel, 'vigente', now(), now())
    on conflict (sku_id, regiao, patamar) do update
      set valor_anterior = sku_precos_calculados.valor,
          valor          = excluded.valor,
          custo_base     = excluded.custo_base,
          estado         = 'vigente',
          calculado_em   = excluded.calculado_em,
          updated_at     = now();

    -- Regrava FOB preservando valor_anterior.
    insert into public.sku_precos_calculados
      (sku_id, regiao, patamar, valor, custo_base, estado, calculado_em, updated_at)
    values
      (p_sku_id, v_regiao, 'FOB', v_valor_fob, v_custo_variavel, 'vigente', now(), now())
    on conflict (sku_id, regiao, patamar) do update
      set valor_anterior = sku_precos_calculados.valor,
          valor          = excluded.valor,
          custo_base     = excluded.custo_base,
          estado         = 'vigente',
          calculado_em   = excluded.calculado_em,
          updated_at     = now();
  end loop;

  -- 5) Conclui: SKU vigente.
  update public.produto_skus
     set estado_calculo = 'vigente',
         updated_at     = now()
   where id = p_sku_id;

  return 'vigente';
end;
$$;

-- ---------------------------------------------------------------------
-- Parte 2: recalculo dos SKUs que cruzam fronteira de vigencia no dia.
-- Fronteira = faixa que ENTRA hoje (vigencia_inicio = hoje) ou que VENCEU
-- ontem (vigencia_fim = hoje - 1, abrindo espaco p/ outra faixa assumir).
-- Cobre insumo_precos (fabricados) e sku_custo_aquisicao (comprados).
-- ---------------------------------------------------------------------
create or replace function public.fn_recalcular_skus_virada()
returns integer
language plpgsql
as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  r record;
  n integer := 0;
begin
  for r in
    select distinct sc.sku_id as sku_id
    from public.sku_composicao sc
    join public.insumo_precos ip on ip.insumo_id = sc.insumo_id
    where ip.vigencia_inicio = v_hoje
       or ip.vigencia_fim = v_hoje - 1
    union
    select sca.sku_id as sku_id
    from public.sku_custo_aquisicao sca
    where sca.vigencia_inicio = v_hoje
       or sca.vigencia_fim = v_hoje - 1
  loop
    perform public.fn_recalcular_sku(r.sku_id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- Parte 3: agendamento pg_cron. '1 3 * * *' UTC = 00:01 BRT (UTC-3),
-- logo apos a virada do dia. Unschedule condicional antes (idempotente).
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'recalc-virada-vigencia') then
    perform cron.unschedule('recalc-virada-vigencia');
  end if;
end;
$$;

select cron.schedule(
  'recalc-virada-vigencia',
  '1 3 * * *',
  $cron$select public.fn_recalcular_skus_virada()$cron$
);
