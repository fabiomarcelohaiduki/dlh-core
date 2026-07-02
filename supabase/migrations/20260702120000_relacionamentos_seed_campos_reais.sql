-- =====================================================================
-- Feature: Relacionamentos (GraphLink) - corrige campos das regras seed
--
-- O seed 20260630030000 cadastrou 5 regras macro apontando para campos que
-- NAO existem como coluna fisica na tabela-fonte - as chaves de match reais
-- vivem no jsonb `payload_bruto` (avisos) ou tem outro nome fisico (pessoas).
-- Resultado: uma regra dessas estourava 500 no dry-run ("column
-- avisos.numero_pregao does not exist") e geraria 0 arestas no backfill.
--
-- Com o motor entendendo dotted-path (payload_bruto.uasg) e o picker
-- listando as chaves jsonb (migration 20260702110000), este UPDATE
-- realinha as regras aos campos REAIS. Idempotente: so afeta linhas que
-- ainda tem o campo antigo (re-aplicacao vira no-op).
--
-- Mapeamento (confirmado no substrato):
--   #1 aviso/uasg           -> aviso/payload_bruto.uasg
--   #3 pessoa/razao_social  -> pessoa/nome_razao_social  (coluna fisica real)
--   #5 aviso/[numero_pregao,uasg] (composta)
--                           -> aviso/[payload_bruto.processo, payload_bruto.uasg]
--
-- #2 pessoa/cnpj JA aponta pra coluna fisica valida (nao mexe).
-- #4 processo/serie_m NAO tinha fonte valida (nem coluna nem chave jsonb em
--    nomus_processos). Decisao do dono (2026-07-02): REMOVER a regra em vez
--    de mante-la inerte -> ver 20260702130000_relacionamentos_remove_serie_m.sql.
-- =====================================================================

-- #1 aviso/uasg -> payload_bruto.uasg (simples).
update public.catalogo_regras_vinculo
set campo_origem = 'payload_bruto.uasg',
    campo_destino = 'payload_bruto.uasg',
    sequencia = array['payload_bruto.uasg']::text[]
where origem_tipo = 'aviso'
  and destino_tipo = 'aviso'
  and combinacao = 'simples'
  and campo_origem = 'uasg'
  and campo_destino = 'uasg';

-- #3 pessoa/razao_social -> nome_razao_social (coluna fisica real, simples).
update public.catalogo_regras_vinculo
set campo_origem = 'nome_razao_social',
    campo_destino = 'nome_razao_social',
    sequencia = array['nome_razao_social']::text[]
where origem_tipo = 'pessoa'
  and destino_tipo = 'pessoa'
  and combinacao = 'simples'
  and campo_origem = 'razao_social'
  and campo_destino = 'razao_social';

-- #5 aviso/[numero_pregao,uasg] -> [payload_bruto.processo, payload_bruto.uasg]
--    (composta; campo_origem/campo_destino acompanham o 1o elemento da
--    sequencia por convencao do seed).
update public.catalogo_regras_vinculo
set campo_origem = 'payload_bruto.processo',
    campo_destino = 'payload_bruto.processo',
    sequencia = array['payload_bruto.processo','payload_bruto.uasg']::text[]
where origem_tipo = 'aviso'
  and destino_tipo = 'aviso'
  and combinacao = 'composta'
  and campo_origem = 'numero_pregao'
  and campo_destino = 'numero_pregao'
  and sequencia = array['numero_pregao','uasg']::text[];

-- ---------------------------------------------------------------------
-- Sentinela RNF-14 realinhada: o numero do pregao agora e a chave jsonb
-- `payload_bruto.processo`. Uma regra SIMPLES sobre ela (sozinha) repete
-- entre UASGs -> arestas falsas. O guard passa a bloquear o campo real
-- (mantendo o legado 'numero_pregao' coberto por seguranca). Mesma
-- mensagem PT-BR da borda zod.
-- ---------------------------------------------------------------------
create or replace function public.tg_catalogo_regras_vinculo_anti_numero_pregao()
returns trigger
language plpgsql
as $$
begin
  if new.combinacao = 'simples'
     and new.campo_destino in ('numero_pregao', 'payload_bruto.processo') then
    raise exception 'Numero do pregao sozinho gera falsos positivos. Use regra composta com UASG.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.tg_catalogo_regras_vinculo_anti_numero_pregao() is
  'Relacionamentos: dispara excecao quando combinacao=''simples'' e campo_destino e o numero do pregao sozinho (''numero_pregao'' legado ou ''payload_bruto.processo'' real) - anti falso-positivo no backfill.';
