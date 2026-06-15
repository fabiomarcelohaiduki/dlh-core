-- =====================================================================
-- Migration: resumo_indexacao — contagem de documentos por status de
--   INDEXACAO (embeddings), filtrada por fonte. Alimenta o painel de
--   Indexacao do cockpit com a foto da fila (pendente / em_andamento /
--   concluida / erro) para a(s) fonte(s) selecionada(s).
--
--   So conta documentos INDEXAVEIS (texto presente e nao vazio): docs sem
--   texto nunca entram na fila (o claim os ignora), entao incluir-los
--   inflaria 'pendente' com itens nao-acionaveis.
--
--   Filtro por fonte = mesmo join do claim (documento_vinculos.fonte).
--   p_fontes null = todas as fontes.
--
--   SECURITY DEFINER + service_role only: contagem de substrato vem SEMPRE
--   do service role (RLS/grant da role authenticated e fragil para count).
--
--   Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
--   padrao do projeto (NUNCA supabase db push).
-- =====================================================================

create or replace function public.resumo_indexacao(
  p_fontes text[]
)
returns table (status text, total bigint)
language sql
security definer
set search_path = public
as $$
  select d.status_indexacao::text as status, count(*)::bigint as total
  from public.documentos d
  where d.texto is not null
    and length(d.texto) > 0
    and (
      p_fontes is null
      or exists (
        select 1 from public.documento_vinculos v
        where v.documento_id = d.id
          and v.fonte = any(p_fontes)
      )
    )
  group by d.status_indexacao;
$$;

comment on function public.resumo_indexacao(text[]) is
  'Contagem de documentos indexaveis (texto presente) por status_indexacao, filtrada por fonte (documento_vinculos). p_fontes null = todas. Alimenta o painel de Indexacao do cockpit.';

revoke all on function public.resumo_indexacao(text[]) from public, anon, authenticated;
grant execute on function public.resumo_indexacao(text[]) to service_role;
