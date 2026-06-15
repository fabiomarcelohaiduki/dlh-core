-- =====================================================================
-- Tool #4 do RAG: SQL read-only no SUBSTRATO TABULAR de licitacao.
--
-- Permite a Lia responder o que a busca semantica NAO faz: COUNT, GROUP BY,
-- filtro exato e joins entre as entidades de fato (avisos, processos,
-- pessoas, documentos, vinculos). A Lia RACIOCINA (escreve o SELECT), mas
-- SEMPRE dentro de travas DETERMINISTICAS no banco:
--
--   1. Schema `lia` com VIEWS CURADAS: so colunas leves/uteis. Tudo pesado
--      ou sensivel fica FORA (conteudo_verbatim, payload_bruto, texto,
--      analise_credito, embeddings, hashes, tokens). Produtos NAO entra
--      (custo/lucro/BOM ja sao cobertos/mascarados por v1-produtos-consulta).
--   2. Role read-only `lia_sql`: GRANT SELECT so em `lia.*`, nada de public.
--      Defesa em profundidade: mesmo se o guard de texto falhar, a role nao
--      alcanca custo/lucro/token/texto.
--   3. RPC `executar_sql_lia`: SELECT-only (so 'select'/'with', sem ';'),
--      SET ROLE lia_sql, search_path = lia, statement_timeout = 5s.
--   4. LIMIT forcado (cap 1000) com deteccao de truncamento.
--
-- SECURITY DEFINER, executavel APENAS por service_role: a autorizacao
-- (sessao humana OU API key da Lia) e garantida na borda (Edge Function).
--
-- Idempotente (create schema/role if not exists, create or replace).
-- Aplicar via Node `pg` (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Schema dedicado das views curadas.
-- ---------------------------------------------------------------------
create schema if not exists lia;

-- ---------------------------------------------------------------------
-- Role read-only. NOLOGIN: so usada via SET ROLE dentro da RPC definer.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lia_sql') then
    create role lia_sql nologin;
  end if;
end
$$;

-- Permite o SET ROLE lia_sql dentro da funcao SECURITY DEFINER (owner = postgres
-- precisa ser membro do role-alvo para assumi-lo).
grant lia_sql to postgres;

-- ---------------------------------------------------------------------
-- Views curadas (colunas explicitas; nada pesado/sensivel).
-- ---------------------------------------------------------------------

-- avisos (Effecti): fora -> conteudo_verbatim, payload_bruto, conteudo_hash.
create or replace view lia.avisos as
select
  id, effecti_id, modalidade, orgao, objeto, portal,
  data_inicial, data_final, data_captura, data_publicacao,
  confiabilidade, origem, favorito, na_lixeira, status_indexacao,
  created_at, updated_at
from public.avisos;

-- processos (Nomus): fora -> payload_bruto, hash_conteudo.
create or replace view lia.processos as
select
  id, nomus_id, tipo, etapa, empresa, pessoa, nome, reportador, responsavel,
  descricao, data_criacao, data_alteracao, status_indexacao, created_at
from public.nomus_processos;

-- pessoas (Nomus): PII de operacao interna SIM; fora -> payload_bruto,
-- analise_credito (sensivel) e endereco detalhado (ruido).
create or replace view lia.pessoas as
select
  id, nomus_id, nome, nome_razao_social, codigo, cnpj, tipo_pessoa, ativo,
  email, telefone, municipio, uf, observacoes, categorias,
  data_criacao, data_modificacao, created_at
from public.nomus_pessoas;

-- documentos: so metadados; fora -> texto (lido via ler_documento), sha256,
-- hash_texto_normalizado.
create or replace view lia.documentos as
select
  id, nome_arquivo, extensao, tamanho_bytes, tipo_documento, usou_ocr, via,
  texto_chars, status_indexacao, created_at
from public.documentos;

-- vinculos doc<->fonte: fora -> ref_obtencao (pode conter URL/parametros).
create or replace view lia.documento_vinculos as
select
  id, documento_id, fonte, registro_origem_id, nome_anexo, status_extracao, erro,
  created_at
from public.documento_vinculos;

-- ---------------------------------------------------------------------
-- Grants da role read-only: USAGE no schema + SELECT nas views, nada mais.
-- ---------------------------------------------------------------------
grant usage on schema lia to lia_sql;
grant select on all tables in schema lia to lia_sql;
alter default privileges in schema lia grant select on tables to lia_sql;

-- ---------------------------------------------------------------------
-- RPC: executa um SELECT da Lia sob as travas. Retorna
--   { truncado: bool, row_count: int, linhas: jsonb[] }.
--
-- A trava de privilegio NAO usa SET ROLE (proibido dentro de SECURITY
-- DEFINER pelo Postgres). Em vez disso a funcao e SECURITY DEFINER e
-- PERTENCE ao role read-only lia_sql: assim o SQL dinamico executa COM os
-- privilegios do lia_sql (SELECT so em lia.*), nada de public. Mesmo efeito
-- de defesa em profundidade, sem o set_config('role').
-- ---------------------------------------------------------------------
create or replace function public.executar_sql_lia(
  p_sql    text,
  p_limite int default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = lia, pg_temp
as $$
declare
  v_limite int  := least(greatest(coalesce(p_limite, 1000), 1), 1000);
  v_norm   text := lower(btrim(coalesce(p_sql, '')));
  v_rows   jsonb;
  v_count  int;
begin
  -- Guard de texto (camada 1; a trava REAL e o role + a estrutura da query).
  if v_norm = '' then
    raise exception 'sql vazio' using errcode = '22023';
  end if;
  if position(';' in p_sql) > 0 then
    raise exception 'apenas UM comando SELECT; ponto-e-virgula nao e permitido'
      using errcode = '22023';
  end if;
  if v_norm !~ '^(with|select)[[:space:](]' then
    raise exception 'apenas consultas SELECT/WITH sao permitidas'
      using errcode = '0A000';
  end if;

  -- Trava deterministica de tempo (a trava de privilegio e o owner lia_sql).
  perform set_config('statement_timeout', '5000', true);

  -- LIMIT forcado: pega limite+1 para detectar truncamento. O envelope subquery
  -- forca o p_sql a ser uma subconsulta (um data-modifying CTE no topo vira erro
  -- do planner). A trava REAL contra statement-stacking via esta interpolacao e
  -- o guard de ';' acima; contra escrita, o owner read-only lia_sql.
  execute format(
    'select coalesce(jsonb_agg(sub), ''[]''::jsonb) from (select * from (%s) q limit %s) sub',
    p_sql, v_limite + 1
  ) into v_rows;

  v_count := jsonb_array_length(v_rows);
  if v_count > v_limite then
    v_rows := (
      select coalesce(jsonb_agg(e order by o), '[]'::jsonb)
        from jsonb_array_elements(v_rows) with ordinality t(e, o)
       where o <= v_limite
    );
    return jsonb_build_object('truncado', true, 'row_count', v_limite, 'linhas', v_rows);
  end if;
  return jsonb_build_object('truncado', false, 'row_count', v_count, 'linhas', v_rows);
end;
$$;

-- A funcao roda como lia_sql (read-only). Para receber a propriedade, lia_sql
-- precisa transitoriamente de CREATE no schema da funcao (public); concedido so
-- para a transferencia e revogado em seguida — lia_sql NAO fica podendo criar
-- objetos em public. postgres ja e membro de lia_sql (grant acima).
grant create on schema public to lia_sql;
alter function public.executar_sql_lia(text, int) owner to lia_sql;
revoke create on schema public from lia_sql;

comment on function public.executar_sql_lia(text, int) is
  'Tool #4 RAG: executa um SELECT read-only da Lia sobre o schema lia (views curadas de licitacao) sob travas deterministicas (owner lia_sql -> SELECT so em lia.*, search_path lia, statement_timeout 5s, LIMIT 1000). Retorna {truncado,row_count,linhas}. Autorizacao na borda; somente service_role executa.';

-- Hardening: somente service_role executa (uso server-side nas Edge Functions).
revoke all on function public.executar_sql_lia(text, int) from public, anon, authenticated;
grant execute on function public.executar_sql_lia(text, int) to service_role;
