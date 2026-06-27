-- =====================================================================
-- FIDELIDADE DE DESCRICAO (blindagem do caminho de lotes).
--
-- POR QUE EXISTE (caso aviso 7715433, Buriti Alegre-GO, 2026-06-21):
--   O gate de fidelidade da Sprint 1 (documento_verbatim_contem) confere
--   apenas NUMEROS (preco / quantidade grande). Ele NAO confere a DESCRICAO
--   do item contra o texto-fonte. Num edital gigante (>1M chars) extraido em
--   LOTES, o extrator ALUCINOU uma lista coerente-porem-errada: descricoes
--   que NAO existem no documento (item 010 "Caixa de papelao" onde o edital
--   diz "AROMATIZANTE"). Como o preco_referencia era null (nada para grepar)
--   e quantidades grandes coincidem por acaso num texto de 1M chars, a
--   alucinacao passou e o doc foi SELADO 'extraido' silenciosamente.
--
-- O QUE ENTRA:
--   RPC documento_tokens_presentes: grep reverso NORMALIZADO (lower + sem
--   acento) dos TOKENS DISTINTIVOS de uma descricao. Recebe os tokens (>=5
--   chars, ja lower+sem-acento no Edge) e devolve quais ocorrem no texto-fonte.
--   O Edge marca 'suspeito' o item tecnica cuja descricao tem ZERO tokens
--   presentes (alucinacao) — sem nunca dropar (recall total).
--
-- DIFERENCA vs documento_verbatim_contem:
--   - aquela e CASE/ACENTO-SENSITIVE (position cru) — serve para NUMERO, que
--     e copiado verbatim.
--   - esta NORMALIZA os dois lados (translate de acentos + lower) — serve para
--     PALAVRA, que pode variar caixa/acento entre extracao e texto-fonte.
--   O texto e normalizado UMA vez (CTE) e nunca cruza a rede (B5).
--
-- NORMA: idempotente (create or replace). Aplicar via node pg direto
-- (SUPABASE_DB_URL session pooler), NUNCA supabase db push.
-- =====================================================================

create or replace function public.documento_tokens_presentes(
  p_documento_id uuid,
  p_tokens       text[]
)
returns text[]
language sql
stable
security definer
set search_path = public, extensions
as $$
  -- Normaliza o verbatim UMA vez: lower + remove acento (mesmo mapa que o
  -- Edge aplica nos tokens com NFD-strip). O cross join reusa este texto unico
  -- para todos os tokens; position() roda em C dentro do Postgres.
  with doc as (
    select translate(
             lower(d.texto),
             'áàâãäéèêëíìîïóòôõöúùûüçñ',
             'aaaaaeeeeiiiiooooouuuucn'
           ) as t
    from public.documentos d
    where d.id = p_documento_id
      and d.texto is not null
  )
  select coalesce(array_agg(tk.tok), '{}'::text[])
  from unnest(p_tokens) as tk(tok)
  cross join doc
  where tk.tok is not null
    and tk.tok <> ''
    and position(tk.tok in doc.t) > 0;
$$;

comment on function public.documento_tokens_presentes(uuid, text[]) is
  'Grep reverso NORMALIZADO da fidelidade de descricao: dado o texto verbatim de um documento (documentos.texto), normaliza (lower + remove acento) e devolve quais dos tokens distintivos (palavras >=5 chars) ocorrem. Mantem o verbatim no banco (nao trafega). Autorizacao na borda; somente service_role.';

revoke all on function public.documento_tokens_presentes(uuid, text[]) from public, anon, authenticated;
grant execute on function public.documento_tokens_presentes(uuid, text[]) to service_role;
