-- =====================================================================
-- Sprint: Substrato de dados (secao 2.2 da SPEC)
-- Migration 04/08: Row Level Security (RLS)
-- Habilita RLS em TODAS as 9 tabelas e aplica a policy unica do MVP:
--   "usuario autenticado E autorizado (consta em contas_autorizadas por
--    e-mail OU dominio, ativo = true) tem acesso pleno" (US-21, RNF-01).
-- Defense in depth: somada a validacao server-side nas Edge Functions.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Funcao auxiliar: avalia se o usuario autenticado consta na allowlist.
-- SECURITY DEFINER para ler contas_autorizadas ignorando a propria RLS
-- (evita recursao infinita na policy de contas_autorizadas).
-- Considera e-mail completo (tipo='email') ou o dominio derivado da parte
-- apos o "@" do e-mail autenticado (tipo='dominio'), sempre com ativo=true.
-- ---------------------------------------------------------------------
create or replace function public.is_conta_autorizada()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.contas_autorizadas ca
    where ca.ativo = true
      and (
        (ca.tipo = 'email'
          and lower(ca.valor) = lower(nullif(auth.jwt() ->> 'email', '')))
        or
        (ca.tipo = 'dominio'
          and lower(ca.valor) = lower(nullif(split_part(auth.jwt() ->> 'email', '@', 2), '')))
      )
  );
$$;

comment on function public.is_conta_autorizada() is
  'Policy unica do MVP: true quando o e-mail autenticado consta em contas_autorizadas (por e-mail ou dominio) com ativo=true.';

-- ---------------------------------------------------------------------
-- Habilita RLS e cria a policy de acesso pleno em cada tabela.
-- USING controla SELECT/UPDATE/DELETE; WITH CHECK controla INSERT/UPDATE.
-- Sem policy permissiva => acesso negado por padrao (deny-by-default).
-- ---------------------------------------------------------------------

-- avisos
alter table public.avisos enable row level security;
create policy avisos_acesso_autorizado on public.avisos
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- aviso_arquivos
alter table public.aviso_arquivos enable row level security;
create policy aviso_arquivos_acesso_autorizado on public.aviso_arquivos
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- aviso_chunks
alter table public.aviso_chunks enable row level security;
create policy aviso_chunks_acesso_autorizado on public.aviso_chunks
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- execucoes (Realtime respeita esta policy do usuario autorizado)
alter table public.execucoes enable row level security;
create policy execucoes_acesso_autorizado on public.execucoes
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- erros_ingestao
alter table public.erros_ingestao enable row level security;
create policy erros_ingestao_acesso_autorizado on public.erros_ingestao
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- fontes (protege token_cifrado: cliente nao autorizado nao seleciona linha => RNF-02)
alter table public.fontes enable row level security;
create policy fontes_acesso_autorizado on public.fontes
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- config_ingestao
alter table public.config_ingestao enable row level security;
create policy config_ingestao_acesso_autorizado on public.config_ingestao
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- contas_autorizadas (a funcao SECURITY DEFINER evita recursao na avaliacao)
alter table public.contas_autorizadas enable row level security;
create policy contas_autorizadas_acesso_autorizado on public.contas_autorizadas
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- audit_log
alter table public.audit_log enable row level security;
create policy audit_log_acesso_autorizado on public.audit_log
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());
