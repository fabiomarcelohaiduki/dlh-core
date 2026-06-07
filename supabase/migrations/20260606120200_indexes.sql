-- =====================================================================
-- Sprint: Substrato de dados (secao 2.1 da SPEC)
-- Migration 03/08: Indices e busca vetorial HNSW
-- Indices de performance + indice vetorial para busca semantica.
-- (UNIQUE(effecti_id) e UNIQUE(valor) ja sao criados como constraints de
-- coluna na migration de tabelas.)
-- =====================================================================

-- Janela de ingestao por Data de Captura (US-03, RF-05).
create index if not exists idx_avisos_data_captura
  on public.avisos (data_captura);

-- Filtros combinados por modalidade + portal (US-20).
create index if not exists idx_avisos_modalidade_portal
  on public.avisos (modalidade, portal);

-- Busca semantica: indice HNSW sobre o embedding usando distancia de cosseno.
-- Requer pgvector habilitado (vide migration de extensoes). RNF-09.
create index if not exists idx_aviso_chunks_embedding_hnsw
  on public.aviso_chunks
  using hnsw (embedding vector_cosine_ops);

-- Indices auxiliares para as FKs mais consultadas (joins de detalhe/investigacao).
create index if not exists idx_aviso_arquivos_aviso_id
  on public.aviso_arquivos (aviso_id);

create index if not exists idx_aviso_chunks_aviso_id
  on public.aviso_chunks (aviso_id);

create index if not exists idx_erros_ingestao_execucao_id
  on public.erros_ingestao (execucao_id);

create index if not exists idx_erros_ingestao_aviso_id
  on public.erros_ingestao (aviso_id);

create index if not exists idx_config_ingestao_fonte_id
  on public.config_ingestao (fonte_id);

create index if not exists idx_avisos_execucao_origem_id
  on public.avisos (execucao_origem_id);
