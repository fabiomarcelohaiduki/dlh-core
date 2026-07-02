-- =====================================================================
-- Feature: Relacionamentos V2 - F4 (Regras semanticas, revisao leve)
-- Migration ADITIVA e IDEMPOTENTE que introduz o novo vocabulario de
-- status dos candidatos em public.vinculos_inferidos_lia (SPEC §2.1.3,
-- RF-26, gate S5):
--
--   Mapeamento F4:  proposta -> rascunho | ativa -> ativo | rejeitada -> descartado
--
-- COEXISTENCIA (nao dropar a antiga): a CHECK legada inline
-- `status in ('proposta','ativa','rejeitada')` permanece ATIVA em F4 e so
-- sera removida na F5 (gate S6). Enquanto ambas as CHECKs coexistem, a
-- restricao efetiva e a INTERSECAO delas. Por isso a NOVA CHECK e a UNIAO
-- dos dois vocabularios:
--   ('proposta','ativa','rejeitada','rascunho','ativo','descartado')
-- de modo que:
--   * durante F4: nenhuma escrita quebra (a CHECK legada ainda limita ao
--     vocabulario antigo; a nova, sendo superset, nunca bloqueia o que a
--     antiga permite);
--   * apos o DROP da CHECK legada em F5: a nova CHECK (uniao) libera o
--     novo vocabulario rascunho/ativo/descartado sem migration adicional.
--
-- Enum logico sempre via text + CHECK (PRD §D.7). Idempotente via guarda
-- em pg_constraint (nome estavel). Nenhuma policy RLS alterada.
-- =====================================================================

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'vinculos_inferidos_lia_status_revisao_leve_check'
      and conrelid = 'public.vinculos_inferidos_lia'::regclass
  ) then
    alter table public.vinculos_inferidos_lia
      add constraint vinculos_inferidos_lia_status_revisao_leve_check
      check (
        status in (
          'proposta', 'ativa', 'rejeitada',   -- vocabulario legado (drop na F5)
          'rascunho', 'ativo', 'descartado'    -- vocabulario F4 (revisao leve)
        )
      );
  end if;
end
$$;

comment on constraint vinculos_inferidos_lia_status_revisao_leve_check
  on public.vinculos_inferidos_lia is
  'Relacionamentos V2 (F4/S5): CHECK de revisao leve. Uniao do vocabulario legado (proposta/ativa/rejeitada) com o novo (rascunho/ativo/descartado). Coexiste com a CHECK legada ate o DROP na F5 (gate S6). Mapeamento: proposta->rascunho, ativa->ativo, rejeitada->descartado.';
