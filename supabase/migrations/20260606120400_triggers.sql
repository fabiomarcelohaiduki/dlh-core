-- =====================================================================
-- Sprint: Substrato de dados (secao 2.3 da SPEC)
-- Migration 05/08: Triggers de auditoria e updated_at
--   - Audit trail em audit_log para avisos, fontes, config_ingestao e
--     contas_autorizadas (insert/update/delete). (US-10, RF-20, RF-28, RNF-08)
--   - set updated_at = now() em avisos, fontes e config_ingestao.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Funcao de auditoria generica.
-- SECURITY DEFINER: roda como owner (bypass de RLS) para sempre conseguir
-- gravar no audit_log, mesmo em escrita direta de um usuario com RLS.
-- Captura o e-mail autenticado de forma defensiva (auth.jwt() pode nao
-- existir fora de um contexto de request, ex.: pg_cron / migrations).
-- ---------------------------------------------------------------------
create or replace function public.fn_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usuario text;
begin
  begin
    v_usuario := nullif(auth.jwt() ->> 'email', '');
  exception when others then
    v_usuario := null;
  end;

  if (tg_op = 'INSERT') then
    insert into public.audit_log (tabela, registro_id, acao, dados_anteriores, dados_novos, usuario)
    values (tg_table_name, new.id, 'insert', null, to_jsonb(new), v_usuario);
    return new;

  elsif (tg_op = 'UPDATE') then
    insert into public.audit_log (tabela, registro_id, acao, dados_anteriores, dados_novos, usuario)
    values (tg_table_name, new.id, 'update', to_jsonb(old), to_jsonb(new), v_usuario);
    return new;

  elsif (tg_op = 'DELETE') then
    insert into public.audit_log (tabela, registro_id, acao, dados_anteriores, dados_novos, usuario)
    values (tg_table_name, old.id, 'delete', to_jsonb(old), null, v_usuario);
    return old;
  end if;

  return null;
end;
$$;

-- Triggers de auditoria nas tabelas sensiveis (secao 2.3).
create trigger trg_audit_avisos
  after insert or update or delete on public.avisos
  for each row execute function public.fn_audit_log();

create trigger trg_audit_fontes
  after insert or update or delete on public.fontes
  for each row execute function public.fn_audit_log();

create trigger trg_audit_config_ingestao
  after insert or update or delete on public.config_ingestao
  for each row execute function public.fn_audit_log();

create trigger trg_audit_contas_autorizadas
  after insert or update or delete on public.contas_autorizadas
  for each row execute function public.fn_audit_log();

-- ---------------------------------------------------------------------
-- Funcao de set updated_at = now() (BEFORE UPDATE).
-- ---------------------------------------------------------------------
create or replace function public.fn_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Triggers de updated_at (secao 2.3): avisos, fontes, config_ingestao.
create trigger trg_set_updated_at_avisos
  before update on public.avisos
  for each row execute function public.fn_set_updated_at();

create trigger trg_set_updated_at_fontes
  before update on public.fontes
  for each row execute function public.fn_set_updated_at();

create trigger trg_set_updated_at_config_ingestao
  before update on public.config_ingestao
  for each row execute function public.fn_set_updated_at();
