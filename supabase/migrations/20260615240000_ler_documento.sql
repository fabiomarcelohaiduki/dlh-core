-- =====================================================================
-- Tool de leitura integral de documento do ACERVO (por id).
--
-- Contexto: a busca semantica (busca_semantica_documentos) devolve apenas
-- o trecho casado (chunk). Quando esse trecho nao basta para responder, a
-- Lia precisa ler o documento INTEIRO. Documentos podem ser enormes (ate
-- ~4,4M chars), entao a leitura e PAGINADA por caracteres: o consumidor
-- pede uma janela [offset, offset+limite) e pagina conforme necessario.
--
-- Retorno (1 linha): metadados do documento + a fatia de texto pedida +
-- o total de chars (texto_chars) para o consumidor saber se ha mais
-- paginas + as fontes que apontam para ele (documento_vinculos).
--
-- offset normalizado para >= 0; limite normalizado/limitado em
-- [1, 200000] (default 50000) como defesa contra estouro de contexto.
-- substr e 1-indexado: offset 0 do consumidor -> substr a partir de 1.
--
-- SECURITY DEFINER, executavel APENAS por service_role: a autorizacao
-- (sessao humana OU API key da Lia) e garantida na borda (Edge Function).
-- =====================================================================

create or replace function public.ler_documento(
  p_documento_id uuid,
  p_offset       int default 0,
  p_limite       int default 50000
)
returns table (
  documento_id    uuid,
  nome_arquivo    text,
  tipo_documento  text,
  extensao        text,
  usou_ocr        boolean,
  via             text,
  texto_chars     int,
  offset_aplicado int,
  limite_aplicado int,
  texto           text,
  fontes          text[]
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with params as (
    -- defesa em profundidade: offset >= 0, limite em [1, 200000].
    select
      greatest(0, coalesce(p_offset, 0))                       as off,
      greatest(1, least(coalesce(p_limite, 50000), 200000))    as lim
  )
  select
    d.id,
    d.nome_arquivo,
    d.tipo_documento,
    d.extensao,
    d.usou_ocr,
    d.via,
    d.texto_chars,
    (select off from params),
    (select lim from params),
    substr(d.texto, (select off from params) + 1, (select lim from params)),
    coalesce(
      (select array_agg(distinct v.fonte order by v.fonte)
         from public.documento_vinculos v
        where v.documento_id = d.id),
      '{}'::text[]
    ) as fontes
  from public.documentos d
  where d.id = p_documento_id;
$$;

comment on function public.ler_documento(uuid, int, int) is
  'Leitura integral PAGINADA (por chars) de um documento do acervo por id. Retorna metadados + fatia [offset, offset+limite) do texto + texto_chars total + fontes. Autorizacao na borda; somente service_role executa.';

-- Hardening: somente service_role executa (uso server-side nas Edge Functions).
revoke all on function public.ler_documento(uuid, int, int) from public, anon, authenticated;
grant execute on function public.ler_documento(uuid, int, int) to service_role;
