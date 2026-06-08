-- =====================================================================
-- Migration: documentos + documento_vinculos
--   Entidade GLOBAL de documento (camada 1): o arquivo e cidadao de 1a
--   classe; a fonte (Nomus/Effecti/Drive/Gmail) e so um adaptador de
--   obtencao de bytes. Mesmo edital chegando por N portas = 1 documento,
--   N vinculos (decisao Fabio 2026-06-08).
--
--   NAO guarda binario, so o TEXTO extraido (camada 1, Tika). Dedup global
--   ARQUIVO-A-ARQUIVO por hash. Indexacao (chunks/embeddings) reusa o motor
--   existente em memoria_chunks (origem='documento'), nao toca este schema.
--
--   Padrao identico a nomus_schema: PK UUID, RLS is_conta_autorizada,
--   trigger updated_at + audit, status_indexacao com o mesmo check.
--   NAO toca tabelas vivas (avisos, aviso_chunks, nomus_processos, ...).
-- =====================================================================

-- ---------------------------------------------------------------------
-- documentos — o CONTEUDO unico (1 linha por arquivo real).
--   Dedup (ordem de confiabilidade, decisao Fabio 2026-06-08):
--     (2) hash_texto_normalizado = chave canonica de conteudo. Pega
--         "mesmo edital re-salvo/recomprimido" (bytes mudam, texto igual).
--         Errata = texto muda de proposito => hash diferente => doc NOVO
--         (versionamento, nao funde). UNIQUE parcial (so quando ha texto).
--     (1) sha256_bytes = atalho byte-a-byte e resync (indice, nao unique:
--         bytes diferentes podem render o MESMO texto).
--   Dedup fino e decidido no Edge; as constraints sao rede de seguranca.
--   tipo_documento (edital/contrato/ata/planilha) = gancho da CAMADA 2,
--   classificado por conteudo depois; null ate la.
-- ---------------------------------------------------------------------
create table public.documentos (
  id                      uuid primary key default gen_random_uuid(),
  nome_arquivo            text,
  extensao                text,
  tamanho_bytes           bigint,
  sha256_bytes            text,                                  -- atalho byte-a-byte (1)
  hash_texto_normalizado  text,                                  -- chave canonica de conteudo (2)
  texto                   text,                                  -- conteudo extraido (camada 1, verbatim)
  usou_ocr                boolean not null default false,
  via                     text,                                  -- motor: tika | texto | marcacao | imagem
  tipo_documento          text,                                  -- gancho camada 2 (edital/contrato/ata/...)
  status_indexacao        text not null default 'pendente'
    check (status_indexacao in ('pendente', 'em_andamento', 'concluida', 'erro')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Dedup de conteudo: UNIQUE so quando ha texto (PDF imagem sem OCR fica com
-- hash null e deduplica por sha256_bytes no Edge, sem colidir com vazio).
create unique index if not exists uidx_documentos_hash_texto
  on public.documentos (hash_texto_normalizado)
  where hash_texto_normalizado is not null;

create index if not exists idx_documentos_sha256
  on public.documentos (sha256_bytes);

create index if not exists idx_documentos_status_indexacao
  on public.documentos (status_indexacao);

create index if not exists idx_documentos_tipo
  on public.documentos (tipo_documento);

-- ---------------------------------------------------------------------
-- documento_vinculos — aresta N:N fonte <-> documento.
--   Criada quando a fonte DESCOBRE um anexo (status='pendente', sem texto
--   ainda). O runner busca os pendentes, obtem bytes via ref_obtencao,
--   extrai e resolve: doc novo => cria documentos + liga; doc ja existe
--   (hash bate) => so liga (status='herdado'), nem reextrai.
--   documento_id e NULL enquanto pendente (sem FK rigida ate resolver).
--   ref_obtencao = como re-obter os bytes por fonte:
--     nomus:   {"processo_id": "...", "nome": "..."}  (base64 no GET individual)
--     effecti: {"url": "https://..."}                 (URL publica re-fetchavel)
-- ---------------------------------------------------------------------
create table public.documento_vinculos (
  id                  uuid primary key default gen_random_uuid(),
  documento_id        uuid references public.documentos(id),     -- null ate extrair/resolver
  fonte               text not null,                             -- nomus | effecti | drive | gmail
  registro_origem_id  text not null,                             -- id do processo Nomus / aviso Effecti
  nome_anexo          text,
  ref_obtencao        jsonb not null default '{}'::jsonb,        -- como re-obter os bytes
  status_extracao     text not null default 'pendente'
    check (status_extracao in ('pendente', 'extraido', 'herdado', 'erro')),
  erro                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Nao duplicar o mesmo anexo da mesma fonte (idempotencia da descoberta).
create unique index if not exists uidx_documento_vinculos_fonte_registro_anexo
  on public.documento_vinculos (fonte, registro_origem_id, nome_anexo);

create index if not exists idx_documento_vinculos_documento
  on public.documento_vinculos (documento_id);

create index if not exists idx_documento_vinculos_status
  on public.documento_vinculos (status_extracao);

create index if not exists idx_documento_vinculos_fonte_registro
  on public.documento_vinculos (fonte, registro_origem_id);

-- ---------------------------------------------------------------------
-- RLS: mesma policy unica do MVP (is_conta_autorizada). Escrita do runner
-- via Edge usa service_role (bypassa RLS server-side, SEC-05).
-- ---------------------------------------------------------------------
alter table public.documentos enable row level security;
create policy documentos_acesso_autorizado on public.documentos
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

alter table public.documento_vinculos enable row level security;
create policy documento_vinculos_acesso_autorizado on public.documento_vinculos
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

-- ---------------------------------------------------------------------
-- Triggers: updated_at + audit_log (rastreabilidade MOE), reusa fns.
-- ---------------------------------------------------------------------
create trigger trg_set_updated_at_documentos
  before update on public.documentos
  for each row execute function public.fn_set_updated_at();

create trigger trg_audit_documentos
  after insert or update or delete on public.documentos
  for each row execute function public.fn_audit_log();

create trigger trg_set_updated_at_documento_vinculos
  before update on public.documento_vinculos
  for each row execute function public.fn_set_updated_at();

create trigger trg_audit_documento_vinculos
  after insert or update or delete on public.documento_vinculos
  for each row execute function public.fn_audit_log();
