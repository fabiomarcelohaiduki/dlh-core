-- =====================================================================
-- Filtro por execucao na lista mestra da guia "Dados" da Coleta.
--
-- Clicar numa linha da guia "Execucoes" passa a levar a guia "Dados" ja
-- recortada nos registros captados POR aquela execucao. Como so o Effecti tem
-- vinculo direto execucao->aviso (avisos.execucao_origem_id), o recorte usado
-- aqui e uniforme e honesto para as 4 fontes: a JANELA DE TEMPO da execucao.
--
-- Cada execucao e single-flight por fonte (nao ha duas coletas da mesma fonte
-- rodando ao mesmo tempo), entao o captado_em de um registro cai em exatamente
-- UMA janela [inicio, fim] por fonte. O cockpit chama esta funcao com p_fonte =
-- fonte da execucao e a janela [p_captado_de, p_captado_ate], recortando so os
-- registros daquela rodada sem inventar um vinculo que o schema nao tem.
--
-- captado_em ja e derivado na view (Effecti = avisos.data_captura; demais =
-- min(created_at) do vinculo), entao o filtro de janela reaproveita a mesma
-- coluna do keyset, sem nova juncao.
-- =====================================================================

-- A assinatura ganha dois parametros (janela de captacao); a antiga de 7 args
-- sai de cena para nao deixar duas sobrecargas ambiguas no catalogo.
drop function if exists public.coleta_registros_listar(text, text, boolean, text, timestamptz, text, integer);

create or replace function public.coleta_registros_listar(
  p_fonte text default null,
  p_status text default null,
  p_tem_erro boolean default false,
  p_busca text default null,
  p_cursor_captado timestamptz default null,
  p_cursor_id text default null,
  p_limit integer default 25,
  p_captado_de timestamptz default null,
  p_captado_ate timestamptz default null
)
returns setof public.vw_coleta_registros_mestra
language sql
stable
as $$
  select *
  from public.vw_coleta_registros_mestra v
  where (p_fonte is null or v.fonte = p_fonte)
    and (p_status is null or v.status_indexacao_agregado = p_status)
    and (not p_tem_erro or v.qtd_erros > 0)
    and (p_busca is null or v.busca_texto like '%' || lower(p_busca) || '%')
    -- Janela de captacao da execucao (filtro de execucao da guia Dados).
    and (p_captado_de is null or v.captado_em >= p_captado_de)
    and (p_captado_ate is null or v.captado_em <= p_captado_ate)
    and (
      p_cursor_captado is null
      or v.captado_em < p_cursor_captado
      or (v.captado_em = p_cursor_captado and v.id_composto > p_cursor_id)
    )
  order by v.captado_em desc, v.id_composto asc
  limit greatest(1, least(p_limit, 200));
$$;

comment on function public.coleta_registros_listar is
  'Uma pagina (keyset captado_em DESC, id_composto ASC) da lista mestra da Coleta, com filtros fonte/status/tem_erro/busca e janela de captacao [p_captado_de, p_captado_ate] (filtro de execucao da guia Dados) em SQL. Chamada pela Edge coleta-registros via service_role.';

revoke all on function public.coleta_registros_listar(text, text, boolean, text, timestamptz, text, integer, timestamptz, timestamptz) from anon, authenticated;
grant execute on function public.coleta_registros_listar(text, text, boolean, text, timestamptz, text, integer, timestamptz, timestamptz) to service_role;
