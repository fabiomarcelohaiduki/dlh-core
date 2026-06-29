-- =====================================================================
-- Guia "Fila de extração" (entre Dados e Escopo no submódulo Coleta).
--
-- A tela de extração antiga (documentos-descobrir, action=resumo) lia a fila
-- INTEIRA pro Deno e capava cada status em 200 itens (MAX_ITENS_RESUMO). A
-- guia nova segue o padrão das outras (Dados/Execuções): leitura PAGINADA
-- server-side por keyset, recall total, sem cap.
--
-- Fonte da verdade = documento_vinculos. Cada linha é UM anexo na fila, com
-- status_extracao (7 valores: pendente, extraido, herdado, precisa_ocr, erro,
-- inobtenivel, ignorado). Não há dimensão de "recurso" aqui (a tabela não tem
-- a coluna) — só fonte + status + busca.
--
-- Duas RPCs (espelho de coleta_registros_*):
--   - extracao_fila_contagens(): (fonte, status, qtd). A Edge soma por fonte
--     (chips), por status (cards) e total. As 4 fontes sempre presentes.
--   - extracao_fila_listar(): uma página por keyset (updated_at DESC, id ASC),
--     filtros fonte/status/busca em SQL, clamp [1,200]. Colunas cruas; a Edge
--     deriva link/extensão/avisoUrl (mesma lógica do documentos-descobrir).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Contagens por (fonte, status): alimenta chips de fonte, cards de status e
-- total. As 4 fontes sempre aparecem (status NULL, qtd 0 quando vazias) para
-- o chip nunca sumir; linhas reais vêm do GROUP BY.
-- ---------------------------------------------------------------------
drop function if exists public.extracao_fila_contagens();

create function public.extracao_fila_contagens()
returns table (fonte text, status text, qtd bigint)
language sql
stable
as $$
  select f.fonte, null::text as status, 0::bigint as qtd
  from (values ('effecti'::text), ('nomus'), ('gmail'), ('drive')) as f(fonte)
  where not exists (
    select 1 from public.documento_vinculos v where v.fonte = f.fonte
  )
  union all
  select v.fonte, v.status_extracao, count(*)::bigint as qtd
  from public.documento_vinculos v
  group by v.fonte, v.status_extracao
  order by 1, 2;
$$;

comment on function public.extracao_fila_contagens is
  'Contagens da fila de extração (documento_vinculos) por (fonte, status). As 4 fontes sempre presentes (status NULL/0 quando vazias). A Edge coleta-extracao soma por fonte (chips), por status (cards) e total.';

revoke all on function public.extracao_fila_contagens() from anon, authenticated;
grant execute on function public.extracao_fila_contagens() to service_role;

-- ---------------------------------------------------------------------
-- Página da fila: keyset (updated_at DESC, id ASC). Filtros fonte/status em
-- igualdade exata; busca ilike escapado (200 chars) sobre nome_anexo. Colunas
-- cruas — link/extensão/avisoUrl derivados na Edge. Clamp [1,200].
-- ---------------------------------------------------------------------
drop function if exists public.extracao_fila_listar(text, text, text, timestamptz, uuid, integer);

create function public.extracao_fila_listar(
  p_fonte text default null,
  p_status text default null,
  p_busca text default null,
  p_cursor_updated_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 50
)
returns table (
  id                 uuid,
  documento_id       uuid,
  fonte              text,
  registro_origem_id text,
  nome_anexo         text,
  ref_obtencao       jsonb,
  status_extracao    text,
  erro               text,
  tentativas         integer,
  updated_at         timestamptz
)
language sql
stable
as $$
  select
    v.id,
    v.documento_id,
    v.fonte,
    v.registro_origem_id,
    v.nome_anexo,
    v.ref_obtencao,
    v.status_extracao,
    v.erro,
    v.tentativas_extracao,
    v.updated_at
  from public.documento_vinculos v
  where (p_fonte is null or v.fonte = p_fonte)
    and (p_status is null or v.status_extracao = p_status)
    and (
      p_busca is null
      or v.nome_anexo ilike
           '%' || replace(replace(replace(left(p_busca, 200), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           escape '\'
    )
    and (
      p_cursor_updated_at is null
      or v.updated_at < p_cursor_updated_at
      or (v.updated_at = p_cursor_updated_at and v.id > p_cursor_id)
    )
  order by v.updated_at desc, v.id asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function public.extracao_fila_listar is
  'Uma página (keyset updated_at DESC, id ASC) da fila de extração (documento_vinculos). Filtros fonte/status exatos e busca (ilike escapado, 200 chars) sobre nome_anexo, em SQL; clamp [1,200]. Colunas cruas; a Edge coleta-extracao deriva link/extensão/avisoUrl.';

revoke all on function public.extracao_fila_listar(text, text, text, timestamptz, uuid, integer) from anon, authenticated;
grant execute on function public.extracao_fila_listar(text, text, text, timestamptz, uuid, integer) to service_role;
