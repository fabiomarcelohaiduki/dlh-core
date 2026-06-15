-- =====================================================================
-- Migration: reenfileirar_erros_indexacao — recolocar na fila os
--   documentos que falharam a INDEXACAO (status 'erro').
--
--   CONTEXTO (2026-06-15): erros de backfill sao TRANSITORIOS (429/timeout
--   da OpenAI por burst) e o retry e IDEMPOTENTE — o insert dos chunks e
--   atomico no fim do doc, entao 'erro' => 0 chunks escritos, sem residuo
--   parcial. Reprocessar = mover 'erro' -> 'pendente' e reabrir o ciclo de
--   backfill. Exposto no painel de Indexacao como botao "Reprocessar erros".
--
--   So reenfileira docs INDEXAVEIS (texto_chars > 0) da(s) fonte(s)
--   informada(s) — mesmo filtro do claim/resumo. p_fontes null = todas.
--
--   Ao final dispara reenfileirar_indexacao() (net.http_post no Edge
--   documentos-indexar) para reabrir o auto-encadeamento. Como o
--   documentos-indexar checa o master switch, o disparo e no-op (nao gasta)
--   quando a indexacao esta OFF — os docs apenas ficam 'pendente' prontos
--   para quando ligar.
--
--   NAO desliga os triggers de auditoria/updated_at: o volume de erros e
--   pequeno (centenas), entao auditar a transicao e barato e desejavel
--   (acao do operador). Diferente do backfill de texto_chars (35k linhas),
--   que rodou com session_replication_role=replica.
--
--   Idempotente: create or replace. Aplicar via Node `pg` (SUPABASE_DB_URL),
--   padrao do projeto (NUNCA supabase db push).
-- =====================================================================

create or replace function public.reenfileirar_erros_indexacao(
  p_fontes text[]
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_reenfileirados integer;
begin
  with alvo as (
    update public.documentos d
    set status_indexacao = 'pendente'
    where d.status_indexacao = 'erro'
      and d.texto_chars > 0
      and (
        p_fontes is null
        or exists (
          select 1 from public.documento_vinculos v
          where v.documento_id = d.id
            and v.fonte = any(p_fontes)
        )
      )
    returning d.id
  )
  select count(*)::int into v_reenfileirados from alvo;

  -- Reabre o auto-encadeamento do backfill (no-op se o master switch estiver
  -- OFF; o documentos-indexar checa config_indexacao.ativo).
  if v_reenfileirados > 0 then
    perform public.reenfileirar_indexacao();
  end if;

  return v_reenfileirados;
end;
$$;

comment on function public.reenfileirar_erros_indexacao(text[]) is
  'Move os documentos em status_indexacao=erro de volta para pendente (filtrado por fonte, texto_chars>0) e dispara reenfileirar_indexacao() para reabrir o backfill. Retorna a quantidade reenfileirada. Retry idempotente (chunks inseridos atomicamente no fim do doc).';

revoke all on function public.reenfileirar_erros_indexacao(text[]) from public, anon, authenticated;
grant execute on function public.reenfileirar_erros_indexacao(text[]) to service_role;
