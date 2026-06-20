-- =====================================================================
-- Fundacao de FIDELIDADE + RECALL da extracao de itens (Sprint 1).
--
-- POR QUE EXISTE (plano docs/PLANO_EXTRACAO_ITENS_FIDELIDADE.md, 2026-06-20):
--   A Lia extrai a lista de itens do edital e hoje o servidor confia
--   integralmente no que ela posta (v1-documento-itens-gravar nao valida nada).
--   Esta migration prepara o schema para o servidor VALIDAR a fidelidade
--   (numero copiado do texto-fonte, conferencia de soma) e marcar itens
--   SUSPEITOS sem nunca dropa-los (recall total).
--
-- O QUE ENTRA:
--   1) documento_itens: item_estado (rascunho|revisado|suspeito) + item_origem
--      (deterministico|llm|effecti) + suspeito_motivo. Aditivo/idempotente.
--   2) documentos.itens_status: estende o CHECK para aceitar 'pendente_revisao'
--      (valor RESERVADO para a Sprint 2 — rascunho de PDF; nenhum documento
--      recebe esse status na Sprint 1). NAO ha 'recall_incompleto': o recall do
--      Effecti vive no veredito per-aviso (rebaixamento), nao num estado
--      bloqueante per-documento (B1/B3 do relatorio de validacao).
--   3) RPC documento_verbatim_contem: grep reverso SERVER-SIDE da fidelidade —
--      recebe as agulhas (grafias do numero) e devolve quais ocorrem no
--      documentos.texto, SEM trafegar o verbatim (~4,4M chars) pela rede (B5).
--
-- NORMA: idempotente (if not exists / create or replace / drop if exists).
-- Aplicar via node pg direto (SUPABASE_DB_URL session pooler), NUNCA
-- supabase db push.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Estado/origem/motivo do item (fidelidade). Aditivo.
--    - item_estado default 'revisado': as linhas atuais (extracao da Lia) ja
--      sao revisadas; nao quebra dados existentes. O rascunho deterministico
--      (Sprint 2) grava explicitamente 'rascunho'. O servidor marca 'suspeito'
--      o item que reprova a fidelidade.
--    - item_origem nullable: linhas legadas ficam null (sem NOT NULL forcado).
-- ---------------------------------------------------------------------
alter table public.documento_itens
  add column if not exists item_estado text not null default 'revisado'
    check (item_estado in ('rascunho', 'revisado', 'suspeito'));

alter table public.documento_itens
  add column if not exists item_origem text
    check (item_origem in ('deterministico', 'llm', 'effecti'));

alter table public.documento_itens
  add column if not exists suspeito_motivo text;

-- Fila visual do cockpit / consultas: rascunhos e suspeitos primeiro.
create index if not exists documento_itens_estado_idx
  on public.documento_itens (item_estado)
  where item_estado in ('rascunho', 'suspeito');

-- ---------------------------------------------------------------------
-- 2) Estende o CHECK de documentos.itens_status com 'pendente_revisao'.
--    O CHECK foi criado INLINE (sem nome) em 20260618130000_documento_itens.sql
--    -> o nome autogerado padrao e documentos_itens_status_check, mas para ser
--    robusto a qualquer nome efetivo o DO block localiza E dropa o(s) check(s)
--    que mencionam itens_status, e so entao readiciona com nome conhecido.
--    Idempotente: re-rodar dropa o que esta migration criou e recria identico.
-- ---------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'documentos'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%itens_status%'
  loop
    execute format('alter table public.documentos drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.documentos
  add constraint documentos_itens_status_check
  check (itens_status in
    ('pendente', 'pendente_revisao', 'extraido', 'sem_itens',
     'erro', 'inobtenivel', 'ignorado'));

-- ---------------------------------------------------------------------
-- 3) RPC do grep reverso da fidelidade (B5: o verbatim NUNCA cruza a rede).
--    Recebe p_agulhas (grafias pt-BR do numero do item) e devolve o subconjunto
--    que OCORRE literalmente no documentos.texto. O Edge v1-documento-itens-
--    gravar monta as agulhas (preco/qtd, ja deduplicadas) e marca suspeito o
--    item cujas agulhas nenhuma apareceram. position() roda em C dentro do
--    Postgres; o texto (~4,4M chars) jamais e serializado para o cliente.
--    SECURITY DEFINER + somente service_role (autorizacao garantida na borda).
-- ---------------------------------------------------------------------
create or replace function public.documento_verbatim_contem(
  p_documento_id uuid,
  p_agulhas      text[]
)
returns text[]
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(array_agg(a.agulha), '{}'::text[])
  from unnest(p_agulhas) as a(agulha)
  where a.agulha is not null
    and a.agulha <> ''
    and exists (
      select 1
      from public.documentos d
      where d.id = p_documento_id
        and d.texto is not null
        and position(a.agulha in d.texto) > 0
    );
$$;

comment on function public.documento_verbatim_contem(uuid, text[]) is
  'Grep reverso da fidelidade: dado o texto verbatim de um documento (documentos.texto), devolve quais das agulhas (grafias do numero) ocorrem literalmente. Mantem o verbatim no banco (nao trafega ~4,4M chars). Autorizacao na borda; somente service_role.';

revoke all on function public.documento_verbatim_contem(uuid, text[]) from public, anon, authenticated;
grant execute on function public.documento_verbatim_contem(uuid, text[]) to service_role;
