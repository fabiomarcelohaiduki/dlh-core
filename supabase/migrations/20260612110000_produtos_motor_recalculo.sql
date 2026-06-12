-- =====================================================================
-- Migration: Motor de calculo deterministico + triggers de recalculo
--   (Modulo Produtos - secoes 2.1 [sku_precos_calculados / precisao
--    US-08, RF-13], 2.3 [triggers] da SPEC)
--
--   Entrega:
--     1. public.fn_skus_no_escopo(nivel, escopo) -> set de SKUs por escopo
--        (helper para os triggers de parametros).
--     2. public.fn_recalcular_sku(p_sku_id uuid) -> motor SQL DETERMINISTICO
--        que transforma a composicao de custos em preco regionalizado
--        CIF/FOB e regrava as 10 linhas (5 regioes x CIF/FOB) em
--        public.sku_precos_calculados, preservando valor_anterior.
--     3. Os 6 triggers de recalculo SINCRONO da secao 2.3 que invocam
--        fn_recalcular_sku para os SKUs afetados DENTRO da propria
--        transacao (AFTER), de forma atomica.
--
--   Notas de arquitetura:
--     - Recalculo roda SINCRONO dentro do trigger AFTER (sem pg_cron/pg_net).
--     - O fallback manual POST /skus/:skuId/recalcular (sprint posterior)
--       chamara EXATAMENTE esta fn_recalcular_sku, garantindo paridade.
--     - A SPEC fixa a ESTRUTURA do encadeamento
--       (Custo Variavel -> impostos -> frete -> despesas -> lucro ->
--        ajuste regional -> CIF/FOB); coeficientes/formula exata sao
--       placeholders. Aqui os percentuais (_pct) sao tratados como pontos
--       percentuais (ex.: 12 => 12%) e encadeados multiplicativamente.
--     - FOB = sem frete; CIF = com frete (unica diferenca entre patamares).
--     - Precisao interna de 4 casas em CV e intermediarios; valor final
--       2 casas ROUND_HALF_UP; custo_base mantem 4 casas. round() sobre
--       numeric arredonda "half away from zero" => HALF_UP p/ precos (>=0).
--
--   Migration ADITIVA e IDEMPOTENTE (CREATE OR REPLACE FUNCTION /
--   DROP TRIGGER IF EXISTS antes de CREATE TRIGGER).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper: SKUs afetados por um escopo de parametro (global/linha/produto).
--   global  -> todos os SKUs
--   linha   -> SKUs de produtos da linha
--   produto -> SKUs do produto
-- Retorna vazio quando p_nivel e nulo (ex.: lado inexistente em I/D).
-- ---------------------------------------------------------------------
create or replace function public.fn_skus_no_escopo(
  p_nivel  text,
  p_escopo uuid
)
returns setof uuid
language sql
stable
as $$
  select ps.id
  from public.produto_skus ps
  join public.produtos p on p.id = ps.produto_id
  where p_nivel = 'global'
     or (p_nivel = 'linha'   and p.linha_id    = p_escopo)
     or (p_nivel = 'produto' and ps.produto_id = p_escopo);
$$;

-- ---------------------------------------------------------------------
-- Motor de calculo deterministico de um SKU.
-- Retorna o estado_calculo resultante ('vigente' | 'erro').
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
    -- Vigente: maior vigencia_inicio com vigencia_fim nula ou >= hoje;
    -- empate desempata por created_at mais recente.
    select sca.custo
      into v_custo_aquisicao
    from public.sku_custo_aquisicao sca
    where sca.sku_id = p_sku_id
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

-- ---------------------------------------------------------------------
-- Helper: marca o SKU em erro SEM gravar valor.
-- Tambem reflete 'erro' nas linhas ja materializadas (sem tocar em valor),
-- para que o grid regional sinalize o estado corretamente.
-- ---------------------------------------------------------------------
create or replace function public.fn_marcar_sku_erro(p_sku_id uuid)
returns void
language plpgsql
as $$
begin
  update public.produto_skus
     set estado_calculo = 'erro',
         updated_at     = now()
   where id = p_sku_id;

  update public.sku_precos_calculados
     set estado     = 'erro',
         updated_at = now()
   where sku_id = p_sku_id
     and estado <> 'erro';
end;
$$;

-- =====================================================================
-- TRIGGERS DE RECALCULO SINCRONO (secao 2.3)
-- Cada trigger AFTER invoca fn_recalcular_sku para os SKUs afetados na
-- MESMA transacao. Ao commitar, os precos ja estao recalculados.
-- =====================================================================

-- ---- sku_composicao (I/U/D): recalcula o(s) SKU(s) afetado(s) ----------
create or replace function public.fn_trg_recalc_on_composicao()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT' or tg_op = 'UPDATE') and new.sku_id is not null then
    perform public.fn_recalcular_sku(new.sku_id);
  end if;
  if (tg_op = 'DELETE' or tg_op = 'UPDATE') and old.sku_id is not null
     and old.sku_id is distinct from new.sku_id then
    perform public.fn_recalcular_sku(old.sku_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_recalc_sku_on_composicao on public.sku_composicao;
create trigger trg_recalc_sku_on_composicao
  after insert or update or delete on public.sku_composicao
  for each row execute function public.fn_trg_recalc_on_composicao();

-- ---- insumo_precos (I/U): recalcula SKUs cuja BOM usa o insumo ---------
create or replace function public.fn_trg_recalc_on_insumo_preco()
returns trigger
language plpgsql
as $$
declare
  r record;
begin
  for r in
    select distinct sc.sku_id
    from public.sku_composicao sc
    where sc.insumo_id = new.insumo_id
       or (tg_op = 'UPDATE' and sc.insumo_id = old.insumo_id)
  loop
    perform public.fn_recalcular_sku(r.sku_id);
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_recalc_sku_on_insumo_preco on public.insumo_precos;
create trigger trg_recalc_sku_on_insumo_preco
  after insert or update on public.insumo_precos
  for each row execute function public.fn_trg_recalc_on_insumo_preco();

-- ---- parametros_calculo (I/U/D): recalcula SKUs do escopo afetado ------
create or replace function public.fn_trg_recalc_on_parametro()
returns trigger
language plpgsql
as $$
declare
  r record;
  v_nivel_new text := case when tg_op <> 'DELETE' then new.nivel else null end;
  v_esc_new   uuid := case when tg_op <> 'DELETE' then new.escopo_id else null end;
  v_nivel_old text := case when tg_op <> 'INSERT' then old.nivel else null end;
  v_esc_old   uuid := case when tg_op <> 'INSERT' then old.escopo_id else null end;
begin
  for r in
    select distinct sid from (
      select public.fn_skus_no_escopo(v_nivel_new, v_esc_new) as sid
      union
      select public.fn_skus_no_escopo(v_nivel_old, v_esc_old) as sid
    ) t
    where sid is not null
  loop
    perform public.fn_recalcular_sku(r.sid);
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_recalc_on_parametro on public.parametros_calculo;
create trigger trg_recalc_on_parametro
  after insert or update or delete on public.parametros_calculo
  for each row execute function public.fn_trg_recalc_on_parametro();

-- ---- parametro_regional (I/U/D): idem para o vetor regional ------------
create or replace function public.fn_trg_recalc_on_parametro_regional()
returns trigger
language plpgsql
as $$
declare
  r record;
  v_nivel_new text := case when tg_op <> 'DELETE' then new.nivel else null end;
  v_esc_new   uuid := case when tg_op <> 'DELETE' then new.escopo_id else null end;
  v_nivel_old text := case when tg_op <> 'INSERT' then old.nivel else null end;
  v_esc_old   uuid := case when tg_op <> 'INSERT' then old.escopo_id else null end;
begin
  for r in
    select distinct sid from (
      select public.fn_skus_no_escopo(v_nivel_new, v_esc_new) as sid
      union
      select public.fn_skus_no_escopo(v_nivel_old, v_esc_old) as sid
    ) t
    where sid is not null
  loop
    perform public.fn_recalcular_sku(r.sid);
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_recalc_on_parametro_regional on public.parametro_regional;
create trigger trg_recalc_on_parametro_regional
  after insert or update or delete on public.parametro_regional
  for each row execute function public.fn_trg_recalc_on_parametro_regional();

-- ---- produto_skus AFTER UPDATE OF tempo_producao ----------------------
-- Nao ha risco de recursao: fn_recalcular_sku so altera estado_calculo
-- (e nao tempo_producao), entao o trigger UPDATE OF tempo_producao nao
-- dispara novamente.
create or replace function public.fn_trg_recalc_on_sku_tempo()
returns trigger
language plpgsql
as $$
begin
  perform public.fn_recalcular_sku(new.id);
  return null;
end;
$$;

drop trigger if exists trg_recalc_on_sku_tempo on public.produto_skus;
create trigger trg_recalc_on_sku_tempo
  after update of tempo_producao on public.produto_skus
  for each row
  when (new.tempo_producao is distinct from old.tempo_producao)
  execute function public.fn_trg_recalc_on_sku_tempo();

-- ---- sku_custo_aquisicao (I/U/D): recalcula o SKU comprado ------------
create or replace function public.fn_trg_recalc_on_custo_aquisicao()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT' or tg_op = 'UPDATE') and new.sku_id is not null then
    perform public.fn_recalcular_sku(new.sku_id);
  end if;
  if (tg_op = 'DELETE' or tg_op = 'UPDATE') and old.sku_id is not null
     and old.sku_id is distinct from new.sku_id then
    perform public.fn_recalcular_sku(old.sku_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_recalc_on_custo_aquisicao on public.sku_custo_aquisicao;
create trigger trg_recalc_on_custo_aquisicao
  after insert or update or delete on public.sku_custo_aquisicao
  for each row execute function public.fn_trg_recalc_on_custo_aquisicao();
