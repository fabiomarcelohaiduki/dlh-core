-- =====================================================================
-- Migration: config_busca — perna HIBRIDA (vetorial + lexical via RRF).
--
--   A busca vetorial pura (busca_semantica_documentos) acha por SIGNIFICADO
--   mas erra TERMO EXATO (numero de edital/pregao, UASG, CATMAT, CNPJ) —
--   medido empiricamente: "90095/2026", "UASG 158467" nao aparecem no top-K
--   vetorial, mas a perna lexical (busca_lexical_documentos) acha. A fusao
--   Reciprocal Rank Fusion (RRF) na Edge combina as duas pernas: quem aparece
--   bem ranqueado em qualquer perna sobe; quem aparece nas duas, sobe mais.
--
--   Estas colunas sao o master switch + o tamanho do pool lexical, ambos
--   administraveis pelo cockpit (sem hardcode). Iniciam DESLIGADAS (default
--   false) para A/B ao vivo: liga/desliga sem deploy. O rerank (Cohere) roda
--   DEPOIS da fusao, sobre o conjunto unido.
--
--   hibrida_ativa               master switch da fusao. OFF => Edge usa so o
--                               vetorial (comportamento atual). Default false.
--   hibrida_candidatos_lexical  quantos chunks a perna lexical traz para a
--                               fusao. Cap [1,50] casa com o teto da RPC
--                               busca_lexical_documentos.
--
--   Idempotente (add column if not exists). Aplicar via Node `pg`
--   (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

alter table public.config_busca
  add column if not exists hibrida_ativa boolean not null default false;

alter table public.config_busca
  add column if not exists hibrida_candidatos_lexical int not null default 50;

-- Teto/piso do pool lexical (defense in depth; casa com o cap da RPC).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'config_busca_hibrida_candidatos_lexical_check'
  ) then
    alter table public.config_busca
      add constraint config_busca_hibrida_candidatos_lexical_check
      check (hibrida_candidatos_lexical between 1 and 50);
  end if;
end $$;

comment on column public.config_busca.hibrida_ativa is
  'Master switch da busca hibrida (RRF vetorial + lexical). OFF => vetorial puro. Administravel pelo cockpit.';
comment on column public.config_busca.hibrida_candidatos_lexical is
  'Quantos chunks a perna lexical traz para a fusao RRF (cap [1,50]). Mais candidatos = mais recall lexical.';
