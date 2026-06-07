-- =====================================================================
-- Feature Nomus Processos (secoes 2.1.3 e 2.1.4 da SPEC)
-- Migration: Novas tabelas nomus_processos e memoria_chunks
--
-- Decisao de design DD-01: memoria_chunks e NOVA e COEXISTE com
-- aviso_chunks. NUNCA migrar nem alterar aviso_chunks (risco zero de
-- regressao na busca de avisos em producao - RF-25). Esta migration NAO
-- toca nenhuma tabela viva (aviso_chunks, avisos, fontes, audit_log).
--
-- Ambas as tabelas: PK UUID (gen_random_uuid()), RLS habilitada com a
-- policy unica do MVP is_conta_autorizada() (SEC-04, RNF-03).
-- =====================================================================

-- ---------------------------------------------------------------------
-- nomus_processos (NOVA - secao 2.1.3)
-- Snapshot vigente dos processos coletados do Nomus, com dedup por
-- nomus_id (UNIQUE NOT NULL = chave natural de deduplicacao - RF-15).
-- payload_bruto guarda o GET integral verbatim, nunca mutado (US-08/US-10).
-- empresa e discriminador (famaha/darlu), NAO compoe dedup nem e fronteira
-- de autorizacao (SEC-07: usuario interno ve as duas empresas).
-- ---------------------------------------------------------------------
create table public.nomus_processos (
  id                uuid primary key default gen_random_uuid(),
  nomus_id          text unique not null,                 -- chave de dedup (RF-15)
  tipo              text,                                  -- ex.: 'Venda Governamental'
  etapa             text,                                  -- estado vigente (snapshot, sem historico)
  empresa           text,                                  -- discrimina origem (famaha/darlu)
  pessoa            text,                                  -- cliente/pessoa do processo
  nome              text,
  reportador        text,
  responsavel       text,
  descricao         text,                                  -- principal conteudo textual indexado
  data_criacao      timestamptz,                           -- data do processo na API
  data_alteracao    timestamptz,                           -- data de ultima alteracao (DD-02)
  payload_bruto     jsonb not null default '{}'::jsonb,    -- payload integral do GET (verbatim)
  hash_conteudo     text,                                  -- hash do conteudo textual canonico (RF-19)
  status_indexacao  text not null default 'pendente'
    check (status_indexacao in ('pendente', 'em_andamento', 'concluida', 'erro')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Indices (secao 2.1.3): empresa, tipo, status_indexacao e data_alteracao.
-- (UNIQUE(nomus_id) ja e criado como constraint de coluna acima.)
create index if not exists idx_nomus_processos_empresa
  on public.nomus_processos (empresa);

create index if not exists idx_nomus_processos_tipo
  on public.nomus_processos (tipo);

create index if not exists idx_nomus_processos_status_indexacao
  on public.nomus_processos (status_indexacao);

create index if not exists idx_nomus_processos_data_alteracao
  on public.nomus_processos (data_alteracao);

-- Trigger updated_at = now() (reaproveita fn_set_updated_at existente).
create trigger trg_set_updated_at_nomus_processos
  before update on public.nomus_processos
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------
-- memoria_chunks (NOVA - secao 2.1.4 - DD-01)
-- Indice semantico de memoria, AGNOSTICO de origem. COEXISTE com
-- aviso_chunks (intacta). origem = discriminador ('aviso','processo',...),
-- registro_id = ref generica ao registro de origem (ex.: nomus_processos.id),
-- SEM FK rigida cross-tabela (acoplamento logico, secao 2.5).
-- embedding vector(1024): mesma dimensao do substrato/bge-m3.
-- ---------------------------------------------------------------------
create table public.memoria_chunks (
  id            uuid primary key default gen_random_uuid(),
  origem        text not null,                             -- discriminador ('aviso','processo',...)
  tipo          text,                                      -- discriminador fino (ex.: 'processo-venda-governamental')
  registro_id   uuid not null,                             -- ref generica ao registro de origem (sem FK rigida)
  chunk_index   int not null default 0,                    -- ordem do chunk no documento
  verbatim      text not null,                             -- trecho textual original
  embedding     vector(1024) not null,                     -- embedding bge-m3
  created_at    timestamptz not null default now()
);

-- Busca semantica: indice HNSW (cosine) IDENTICO ao de aviso_chunks (RNF-08).
create index if not exists idx_memoria_chunks_embedding_hnsw
  on public.memoria_chunks
  using hnsw (embedding vector_cosine_ops);

-- Indice composto (origem, registro_id): limpeza idempotente de chunks de um
-- registro (origem+registro_id) e filtro de escopo da busca generalizada.
create index if not exists idx_memoria_chunks_origem_registro
  on public.memoria_chunks (origem, registro_id);

-- ---------------------------------------------------------------------
-- RLS (secao 2.2): mesma policy unica do MVP nas duas tabelas novas.
-- USING controla SELECT/UPDATE/DELETE; WITH CHECK controla INSERT/UPDATE.
-- Deny-by-default. A escrita da coleta usa service_role (bypassa RLS)
-- apenas server-side (SEC-05). aviso_chunks NAO e tocada.
-- ---------------------------------------------------------------------
alter table public.nomus_processos enable row level security;
create policy nomus_processos_acesso_autorizado on public.nomus_processos
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

alter table public.memoria_chunks enable row level security;
create policy memoria_chunks_acesso_autorizado on public.memoria_chunks
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());
