-- =====================================================================
-- Migration: resumo_indexacao_avisos — contagem dos AVISOS (licitacoes
--   Effecti) por status_indexacao (embeddings -> aviso_chunks). Alimenta o
--   painel de Indexacao do cockpit com a foto da fila de avisos.
--
--   MOTIVACAO (2026-06-22): o painel de Indexacao so enxergava a tabela
--   public.documentos (anexos), via resumo_indexacao(p_fontes). Os AVISOS
--   sao uma tabela SEPARADA (public.avisos -> aviso_chunks) com ciclo de
--   indexacao proprio. Um furo de recall silencioso (445 avisos travados em
--   status_indexacao='pendente' com 0 chunks) ficou INVISIVEL no cockpit
--   porque o painel nunca contou avisos -> dizia "0 pendente para effecti".
--   Esta RPC fecha o ponto cego: o painel passa a surfar a fila de avisos.
--
--   Avisos = fonte UNICA (Effecti) -> SEM filtro de fonte (espelha
--   resumo_indexacao_processos, nao resumo_indexacao). Conta TODOS os avisos
--   por status (todo aviso deveria estar indexado; um preso em 'pendente' e
--   exatamente o sinal que queremos ver).
--
--   Vocabulario de status dos avisos: 'pendente' / 'indexado' / 'erro'
--   (difere de documentos, que usa 'concluida'). O mapeamento status->bucket
--   do painel fica no Edge (indexado -> bucket "concluida"/Indexados).
--
--   SECURITY DEFINER + service_role only: contagem de substrato vem SEMPRE
--   do service role (RLS/grant da role authenticated e fragil para count).
--
--   Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
--   padrao do projeto (NUNCA supabase db push).
-- =====================================================================

create or replace function public.resumo_indexacao_avisos()
returns table (status text, total bigint)
language sql
security definer
set search_path = public
as $$
  select coalesce(a.status_indexacao, 'pendente')::text as status,
         count(*)::bigint as total
  from public.avisos a
  group by coalesce(a.status_indexacao, 'pendente');
$$;

comment on function public.resumo_indexacao_avisos() is
  'Contagem dos avisos (licitacoes Effecti) por status_indexacao (status null tratado como pendente). Alimenta o painel de Indexacao do cockpit (perna de avisos). Sem filtro de fonte: avisos sao fonte unica.';

revoke all on function public.resumo_indexacao_avisos() from public, anon, authenticated;
grant execute on function public.resumo_indexacao_avisos() to service_role;
