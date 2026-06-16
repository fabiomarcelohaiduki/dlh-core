-- RLS no modulo de produtos/cotacao/precificacao.
--
-- As 18 tabelas abaixo nasceram SEM Row Level Security (esquecido nas migrations
-- das tabelas novas), enquanto todo o substrato de ingestao ja tinha RLS+policy.
-- O Security Advisor do Supabase as marcava como CRITICAL ("RLS Disabled in
-- Public"): expostas via PostgREST, a anon key poderia ler/escrever custos,
-- margens e composicao -- dado competitivo da DLH.
--
-- Acesso confirmado 100% via Edge functions (service_role, que bypassa RLS);
-- NENHUMA e lida direto pelo frontend. Logo, replicamos EXATAMENTE o padrao das
-- 26 tabelas existentes: 1 policy PERMISSIVE, cmd ALL, role public, com
-- using/with_check = is_conta_autorizada(). Resultado:
--   anon / nao-autorizado -> bloqueado;  conta autorizada -> acessa;
--   Edge (service_role) e Lia (lia_sql BYPASSRLS) -> inalterados.
--
-- Idempotente (enable e no-op se ja ligado; drop policy if exists antes do create).
-- Aplicado via pg direto (SUPABASE_DB_URL), NAO via supabase db push.

do $$
declare
  t text;
  tabelas text[] := array[
    'produtos','produto_linhas','produto_linha_atributos','produto_atributos',
    'produto_skus','produto_imagens','insumos','insumo_precos','sku_composicao',
    'sku_custo_aquisicao','sku_precos_calculados','parametros_calculo',
    'parametro_regional','cotacao_diretrizes','cotacao_regras',
    'politica_participacao','clientes_revenda','revenda_precos'
  ];
begin
  foreach t in array tabelas loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_acesso_autorizado', t);
    execute format(
      'create policy %I on public.%I for all to public '
      || 'using (public.is_conta_autorizada()) with check (public.is_conta_autorizada())',
      t || '_acesso_autorizado', t
    );
  end loop;
end $$;
