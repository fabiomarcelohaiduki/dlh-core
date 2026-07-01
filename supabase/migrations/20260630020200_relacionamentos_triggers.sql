-- =====================================================================
-- Feature: Relacionamentos (Documento feature-relacionamentos.md / SPEC secao 2.3)
-- Migration 3/3: triggers de versao (5 tabelas) + trigger anti
-- numero_pregao sozinho em catalogo_regras_vinculo.
--
-- Padrao tg_<tabela>_updated (mesmo idioma de tg_conhecimentos_updated em
-- 20260618180000_conhecimentos.sql, POREM com coluna `updated_at` - as 5
-- tabelas desta feature usam `updated_at` e nao `atualizado_em`):
--   BEFORE UPDATE FOR EACH ROW: new.versao := coalesce(old.versao, 0) + 1;
--   e new.updated_at := now().
--
-- Funcao DEDICADA `public.tg_relacionamentos_updated` (nao reutiliza
-- `public.tg_conhecimentos_updated`, que seta `new.atualizado_em` e
-- quebraria os triggers desta feature com `record "new" has no field
-- "atualizado_em"`).
--
-- O trigger anti numero_pregao sozinho e defesa em profundidade contra
-- INSERT direto via service_role, bug futuro ou bypass de Edge. A borda
-- zod da Edge e a primeira linha de defesa (retorna 422 com a mesma
-- mensagem). Nao usa SECURITY DEFINER (regra de negocio, nao bypass de RLS).
--
-- Idempotente via drop trigger if exists no cabecalho e
-- `create or replace function` na funcao.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 2.3.1 Funcao DEDICADA tg_relacionamentos_updated.
-- Seta versao e updated_at no UPDATE das 5 tabelas da feature
-- (relacoes, catalogo_regras_vinculo, vinculos_inferidos_lia,
-- config_relacionamentos, config_tipos_no). SECURITY INVOKER (default).
--
-- Espelha o padrao de tg_conhecimentos_updated em
-- 20260618180000_conhecimentos.sql, mas usa `updated_at` (consistente
-- com as 5 tabelas desta feature).
-- ---------------------------------------------------------------------
create or replace function public.tg_relacionamentos_updated()
returns trigger
language plpgsql
as $$
begin
  new.versao := coalesce(old.versao, 0) + 1;
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.tg_relacionamentos_updated() is
  'Relacionamentos: BEFORE UPDATE - seta versao := coalesce(old.versao, 0) + 1 e updated_at := now() nas 5 tabelas da feature (relacoes, catalogo_regras_vinculo, vinculos_inferidos_lia, config_relacionamentos, config_tipos_no). SECURITY INVOKER.';

-- ---------------------------------------------------------------------
-- Triggers tg_<tabela>_updated (5 tabelas).
-- ---------------------------------------------------------------------

-- relacoes
drop trigger if exists tg_relacoes_updated on public.relacoes;
create trigger tg_relacoes_updated
  before update on public.relacoes
  for each row
  execute function public.tg_relacionamentos_updated();

-- catalogo_regras_vinculo
drop trigger if exists tg_catalogo_regras_vinculo_updated on public.catalogo_regras_vinculo;
create trigger tg_catalogo_regras_vinculo_updated
  before update on public.catalogo_regras_vinculo
  for each row
  execute function public.tg_relacionamentos_updated();

-- vinculos_inferidos_lia
drop trigger if exists tg_vinculos_inferidos_lia_updated on public.vinculos_inferidos_lia;
create trigger tg_vinculos_inferidos_lia_updated
  before update on public.vinculos_inferidos_lia
  for each row
  execute function public.tg_relacionamentos_updated();

-- config_relacionamentos
drop trigger if exists tg_config_relacionamentos_updated on public.config_relacionamentos;
create trigger tg_config_relacionamentos_updated
  before update on public.config_relacionamentos
  for each row
  execute function public.tg_relacionamentos_updated();

-- config_tipos_no
drop trigger if exists tg_config_tipos_no_updated on public.config_tipos_no;
create trigger tg_config_tipos_no_updated
  before update on public.config_tipos_no
  for each row
  execute function public.tg_relacionamentos_updated();

-- ---------------------------------------------------------------------
-- 2.3.2 Trigger anti numero_pregao sozinho em catalogo_regras_vinculo.
-- Funcao SECURITY INVOKER (default): regra de negocio, nao bypass de RLS.
-- Mensagem IDENTICA a da borda zod (uma unica frase em PT-BR).
-- ---------------------------------------------------------------------
create or replace function public.tg_catalogo_regras_vinculo_anti_numero_pregao()
returns trigger
language plpgsql
as $$
begin
  if new.combinacao = 'simples' and new.campo_destino = 'numero_pregao' then
    raise exception 'Numero do pregao sozinho gera falsos positivos. Use regra composta com UASG.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.tg_catalogo_regras_vinculo_anti_numero_pregao() is
  'Relacionamentos: dispara excecao quando combinacao=''simples'' e campo_destino=''numero_pregao'' (anti falso-positivo no backfill).';

drop trigger if exists tg_catalogo_regras_vinculo_anti_numero_pregao
  on public.catalogo_regras_vinculo;
create trigger tg_catalogo_regras_vinculo_anti_numero_pregao
  before insert or update on public.catalogo_regras_vinculo
  for each row
  execute function public.tg_catalogo_regras_vinculo_anti_numero_pregao();