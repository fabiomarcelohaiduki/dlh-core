-- =====================================================================
-- Sprint: Substrato de dados (secao 2.1 da SPEC)
-- Migration 02/08: Tabelas
-- Cria TODAS as tabelas do substrato com PKs UUID (gen_random_uuid()) e FKs
-- conforme o diagrama ER (secao 2.5). Schema public no MVP (RNF-14).
--
-- Ordem de criacao respeita dependencias de FK:
--   execucoes -> avisos -> aviso_arquivos / aviso_chunks / erros_ingestao
--   fontes    -> config_ingestao
--   contas_autorizadas (independente) / audit_log (independente)
-- =====================================================================

-- ---------------------------------------------------------------------
-- execucoes — runs de sincronizacao (agendada/manual). (data-execucao)
-- Criada antes de avisos pois avisos.execucao_origem_id referencia execucoes.
-- Realtime sera habilitado nesta tabela (progresso ao vivo - US-15/RF-26).
-- ---------------------------------------------------------------------
create table public.execucoes (
  id                    uuid primary key default gen_random_uuid(),
  inicio                timestamptz not null,
  fim                   timestamptz,
  gatilho               text not null,                 -- 'agendada' | 'manual'
  janela_dias           int,
  novos                 int not null default 0,
  alterados             int not null default 0,
  duracao               text,
  status                text not null,                 -- 'concluida' | 'em_andamento' | 'erro'
  etapa_atual           text,                          -- 'coleta' | 'tratamento' | 'indexacao' | 'persistencia'
  total_processar       int,
  processados_sucesso   int,
  processados_erro      int,
  pendentes             int
);

-- ---------------------------------------------------------------------
-- avisos — substrato central; um registro por aviso do Effecti.
-- effecti_id UNIQUE = chave natural de deduplicacao (upsert futuro - RNF-07).
-- ---------------------------------------------------------------------
create table public.avisos (
  id                    uuid primary key default gen_random_uuid(),
  effecti_id            text unique not null,          -- chave de deduplicacao (US-05)
  modalidade            text not null,
  orgao                 text not null,
  objeto                text not null,
  portal                text,
  conteudo_verbatim     text not null,                 -- conteudo literal integro (US-08, RF-36)
  payload_bruto         jsonb not null,                -- payload completo da API, sem descarte
  data_inicial          timestamptz,
  data_final            timestamptz,
  data_captura          timestamptz not null,          -- janela de ingestao (US-03, RF-05)
  data_publicacao       timestamptz,
  tipo_memoria          text not null default 'fato',  -- governanca MOE
  confiabilidade        text,
  origem                text,
  execucao_origem_id    uuid references public.execucoes(id),  -- execucao geradora
  status_indexacao      text,                          -- controle do pipeline de embeddings
  created_at            timestamptz default now(),
  updated_at            timestamptz
);

-- ---------------------------------------------------------------------
-- aviso_arquivos — arquivos de edital baixados/tratados. (US-19, RF-33)
-- ON DELETE CASCADE: ao apagar o aviso, seus arquivos somem juntos.
-- ---------------------------------------------------------------------
create table public.aviso_arquivos (
  id                    uuid primary key default gen_random_uuid(),
  aviso_id              uuid not null references public.avisos(id) on delete cascade,
  nome_arquivo          text,
  extensao              text,                          -- PDF/DOC/DOCX/ZIP/RAR...
  tamanho_bytes         bigint,
  storage_path          text,                          -- caminho no bucket privado do Storage
  texto_extraido        text,                          -- conteudo verbatim extraido (OCR) (RF-36)
  status_tratamento     text,                          -- 'ok' | 'erro' | 'nao_suportado'
  created_at            timestamptz default now()
);

-- ---------------------------------------------------------------------
-- aviso_chunks — segmentos para embeddings (chunking so para busca).
-- embedding vector(1024): dimensao do placeholder bge-m3 (delta-005).
-- Mudanca de dimensao fica isolada nesta tabela. (US-08, US-18, RF-21)
-- ON DELETE CASCADE: chunks seguem o ciclo de vida do aviso.
-- ---------------------------------------------------------------------
create table public.aviso_chunks (
  id                    uuid primary key default gen_random_uuid(),
  aviso_id              uuid not null references public.avisos(id) on delete cascade,
  ordem                 int,
  conteudo              text not null,
  embedding             vector(1024)
);

-- ---------------------------------------------------------------------
-- erros_ingestao — falhas por item/execucao. (data-erro; US-16, RF-27, RF-40)
-- aviso_id e nullable (erro pode ocorrer antes de existir um aviso).
-- ---------------------------------------------------------------------
create table public.erros_ingestao (
  id                    uuid primary key default gen_random_uuid(),
  execucao_id           uuid references public.execucoes(id),
  aviso_id              uuid references public.avisos(id),   -- nullable (link de investigacao US-14)
  severidade            text not null,                 -- 'alta' | 'media' | 'baixa'
  etapa                 text not null,                 -- 'Coleta' | 'Tratamento' | 'Indexacao'
  mensagem              text not null,
  quando                timestamptz not null,
  status_reprocesso     text                           -- controle de reprocessar/retentar (RF-40)
);

-- ---------------------------------------------------------------------
-- fontes — fonte de ingestao e referencia de credencial. (data-fonte; US-07)
-- token_cifrado guarda apenas REFERENCIA ao segredo no Supabase Vault;
-- nunca exposto em texto pleno (RNF-02) — protegido tambem por RLS.
-- ---------------------------------------------------------------------
create table public.fontes (
  id                    uuid primary key default gen_random_uuid(),
  nome                  text not null,
  tipo                  text not null,                 -- extensivel a novos conectores (RF-11)
  endpoint_base         text not null,
  estado_conexao        text not null,                 -- 'conectada' | 'erro' | 'nao_configurada'
  token_cifrado         text,                          -- referencia ao segredo no Vault (RNF-02)
  created_at            timestamptz default now(),
  updated_at            timestamptz
);

-- ---------------------------------------------------------------------
-- config_ingestao — frequencia, janela e filtros. (data-config-ingestao; US-03, US-20)
-- ---------------------------------------------------------------------
create table public.config_ingestao (
  id                    uuid primary key default gen_random_uuid(),
  fonte_id              uuid references public.fontes(id),
  frequencia            text not null,
  horario_referencia    text,
  janela_dias           int not null,
  modalidades           text[] not null,               -- filtros (US-20)
  portais               text[] not null,               -- filtros (US-20)
  updated_at            timestamptz
);

-- ---------------------------------------------------------------------
-- contas_autorizadas — allowlist de acesso. (US-21, RF-38, RF-39)
-- valor UNIQUE = e-mail completo OU dominio permitido.
-- NOTA: a coluna `role` e gancho de Fase 2 e NAO e implementada agora.
-- ---------------------------------------------------------------------
create table public.contas_autorizadas (
  id                    uuid primary key default gen_random_uuid(),
  tipo                  text not null,                 -- 'email' | 'dominio'
  valor                 text unique not null,          -- e-mail completo ou dominio permitido
  ativo                 boolean not null default true,
  created_at            timestamptz default now()
);

-- ---------------------------------------------------------------------
-- audit_log — audit trail generico (MOE), preenchido por triggers.
-- (US-10, RF-20, RF-28, RNF-08)
-- ---------------------------------------------------------------------
create table public.audit_log (
  id                    uuid primary key default gen_random_uuid(),
  tabela                text not null,
  registro_id           uuid,
  acao                  text not null,                 -- 'insert' | 'update' | 'delete'
  dados_anteriores      jsonb,
  dados_novos           jsonb,
  usuario               text,                          -- e-mail autenticado associado a acao
  quando                timestamptz not null default now()
);
