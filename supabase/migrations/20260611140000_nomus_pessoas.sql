-- =====================================================================
-- Feature Nomus Pessoas (novo recurso do conector Nomus)
-- Migration: tabela nomus_pessoas + watermark nomus_max_pessoa_id +
-- seed do recurso `pessoas` na config_ingestao da fonte Nomus.
--
-- Pessoas = clientes + leads + fornecedores + transportadoras + etc. numa
-- UNICA entidade do Nomus, separadas pelo campo `categorias` (15 booleans).
-- NAO ha `tipo` (diferente de processos): o recurso pessoas NAO usa a
-- allowlist tipos_ativos — coleta TODAS as pessoas, governado apenas pelo
-- master switch `recursos.pessoas.ativo` (igual aos demais modulos).
--
-- Espelha o PADRAO de nomus_processos (20260606140000): PK uuid, dedup por
-- nomus_id (UNIQUE NOT NULL), payload_bruto verbatim, hash_conteudo p/ decisao
-- de reindexacao, status_indexacao, RLS is_conta_autorizada, trigger updated_at.
-- COEXISTE com memoria_chunks (origem='pessoa'); NAO toca nenhuma tabela viva.
--
-- Alteracao ADITIVA e idempotente (if not exists / coalesce). Aplicada via
-- Node `pg` direto (schema_migrations remoto intencionalmente atrasado).
-- =====================================================================

-- ---------------------------------------------------------------------
-- nomus_pessoas (NOVA)
-- Snapshot vigente do cadastro de pessoas coletado do Nomus, dedup por
-- nomus_id (UNIQUE NOT NULL = `id` da API). `observacoes` e o texto livre
-- do cliente (CONFIRMADO serializado pela API quando preenchido) — coluna
-- propria + compoe o verbatim dos embeddings. `categorias` e `analise_credito`
-- ficam como jsonb (15 booleans / rotina de credito). payload_bruto guarda o
-- GET integral verbatim. Metadados de assinatura do Nomus (espaco de arquivos,
-- plano, qtdeCnpjs...) NAO viram coluna: vivem so no payload_bruto.
-- ---------------------------------------------------------------------
create table if not exists public.nomus_pessoas (
  id                      uuid primary key default gen_random_uuid(),
  nomus_id                text unique not null,                 -- chave de dedup (= API id)
  nome                    text,
  nome_razao_social       text,
  codigo                  text,
  cnpj                    text,
  tipo_pessoa             text,                                  -- Pessoa Fisica / Juridica
  ativo                   boolean,
  email                   text,
  telefone                text,
  cep                     text,
  endereco                text,
  numero                  text,
  complemento             text,
  bairro_distrito         text,
  municipio               text,
  uf                      text,
  pais                    text,
  tipo_contribuinte_icms  text,
  observacoes             text,                                  -- texto livre do cliente (indexado)
  data_criacao            timestamptz,                           -- dataCriacao na API
  data_modificacao        timestamptz,                           -- dataModificacao na API
  categorias              jsonb,                                 -- 15 booleans (cliente, lead, fornecedor, ...)
  analise_credito         jsonb,                                 -- rotina de analise de credito (texto/dados)
  payload_bruto           jsonb not null default '{}'::jsonb,    -- GET integral (verbatim)
  hash_conteudo           text,                                  -- hash do conteudo canonico (decisao de reindex)
  status_indexacao        text not null default 'pendente'
    check (status_indexacao in ('pendente', 'em_andamento', 'concluida', 'erro')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Indices: filtro de status de indexacao e por tipo de pessoa / uf (buscas).
create index if not exists idx_nomus_pessoas_status_indexacao
  on public.nomus_pessoas (status_indexacao);

create index if not exists idx_nomus_pessoas_tipo_pessoa
  on public.nomus_pessoas (tipo_pessoa);

create index if not exists idx_nomus_pessoas_uf
  on public.nomus_pessoas (uf);

-- Trigger updated_at = now() (reaproveita fn_set_updated_at existente).
drop trigger if exists trg_set_updated_at_nomus_pessoas on public.nomus_pessoas;
create trigger trg_set_updated_at_nomus_pessoas
  before update on public.nomus_pessoas
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------
-- RLS: mesma policy unica do MVP (is_conta_autorizada). Deny-by-default.
-- A escrita da coleta usa service_role (bypassa RLS) server-side.
-- ---------------------------------------------------------------------
alter table public.nomus_pessoas enable row level security;
drop policy if exists nomus_pessoas_acesso_autorizado on public.nomus_pessoas;
create policy nomus_pessoas_acesso_autorizado on public.nomus_pessoas
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- ---------------------------------------------------------------------
-- Watermark da coleta de pessoas: maior nomus_id ja persistido, comparado
-- NUMERICAMENTE (a coluna e TEXT). Espelha nomus_max_nomus_id() — o coletor
-- de nuvem usa como marca d'agua p/ so puxar pessoas NOVAS (id > marca) no
-- regime incremental. Ids nao-numericos sao ignorados no MAX.
-- ---------------------------------------------------------------------
create or replace function public.nomus_max_pessoa_id()
returns bigint
language sql
stable
security definer
set search_path = public, extensions
as $$
  select max((nomus_id)::bigint)
  from public.nomus_pessoas
  where nomus_id ~ '^[0-9]+$';
$$;

revoke all on function public.nomus_max_pessoa_id() from public, anon, authenticated;
grant execute on function public.nomus_max_pessoa_id() to service_role;

-- ---------------------------------------------------------------------
-- Seed do recurso `pessoas` na config_ingestao da fonte Nomus.
-- Master switch: recursos.pessoas.ativo = true (Edge so ingere pessoas com
-- ativo!==false). So insere a chave quando AINDA NAO existe — re-rodar NAO
-- sobrescreve um toggle ja ajustado pelo Fabio (idempotente, nao destrutivo).
-- Pessoas NAO tem tipos_ativos (sem `tipo`); so o flag ativo governa.
-- ---------------------------------------------------------------------
update public.config_ingestao ci
set recursos = jsonb_set(
      coalesce(ci.recursos, '{}'::jsonb),
      '{pessoas}',
      '{"ativo": true}'::jsonb,
      true
    )
from public.fontes f
where ci.fonte_id = f.id
  and f.tipo = 'nomus'
  and not (coalesce(ci.recursos, '{}'::jsonb) ? 'pessoas');
