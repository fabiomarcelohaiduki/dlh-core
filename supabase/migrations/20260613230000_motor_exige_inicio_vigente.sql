-- =====================================================================
-- Migration: motor so usa faixa cujo INICIO ja chegou (vigencia_inicio <= hoje)
-- =====================================================================
-- Contexto: a fn_recalcular_sku (20260612110000) selecionava a faixa de
-- preco/custo apenas por vigencia_fim (null ou >= hoje) ordenando por
-- vigencia_inicio desc, SEM exigir que o inicio ja tivesse chegado. Isso
-- divergia da tela (que exige inicio <= hoje para marcar "Vigente"): uma
-- faixa com inicio FUTURO ja seria usada pelo motor antes da data, enquanto
-- a tela ainda apontava a faixa anterior.
--
-- Correcao: o motor passa a exigir vigencia_inicio <= current_date nos 3
-- pontos (custo de aquisicao de SKU comprado, check de insumo sem preco e
-- selecao do preco vigente da BOM), ficando consistente com a tela e
-- permitindo cadastrar precos AGENDADOS (so valem a partir do inicio).
--
-- ATENCAO: agendar preco futuro NAO recalcula sozinho na virada da data
-- (o recalculo e sincrono no trigger de escrita; nao ha cron temporal).
-- O preco futuro so entra quando algo dispara um novo recalculo do SKU.
--
-- Idempotente (create or replace). So a fn_recalcular_sku muda; os triggers
-- e demais funcoes permanecem.
-- =====================================================================

create or replace function public.fn_recalcular_sku(p_sku_id uuid)
returns text
language plpgsql
as $$
declare
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
      and sca.vigencia_inicio <= current_date
      and (sca.vigencia_fim is null or sca.vigencia_fim >= current_date)
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
          and ip.vigencia_inicio <= current_date
          and (ip.vigencia_fim is null or ip.vigencia_fim >= current_date)
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
        and ip.vigencia_inicio <= current_date
        and (ip.vigencia_fim is null or ip.vigencia_fim >= current_date)
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
