-- =====================================================================
-- Acesso TOTAL da Lia ao substrato operacional (read-only).
--
-- Ate aqui a role `lia_sql` so enxergava 5 views curadas (lia.*). O Fabio
-- pediu que a Lia alcance TODAS as tabelas e informacoes do dlh-core para
-- raciocinar sobre a operacao (produtos, precos, custos, insumos, cotacao,
-- politica, clientes, etc.).
--
-- Fronteira DETERMINISTICA mantida (SOM: trava no banco, nao na IA):
--   NEGOCIO  = a Lia le TUDO.
--   SEGREDO  = NUNCA (fora por construcao, via GRANT por coluna/tabela).
--
-- O modelo muda de "allowlist de 5 views" para "read-only amplo no public
-- com denylist minima". A auditoria do schema (44 tabelas) confirmou que o
-- unico segredo real em public e fontes.token_cifrado; os tokens OAuth de
-- Drive/Gmail vivem no Vault/GitHub Secrets, fora do public.
--
-- TODAS as outras travas da RPC executar_sql_lia ficam INTACTAS:
--   SELECT/WITH-only, sem ';', LIMIT forcado 1000, statement_timeout 5s,
--   owner read-only lia_sql (sem login, sem bypass RLS), execucao so por
--   service_role. Vault, cron, auth, storage continuam inalcancaveis
--   (lia_sql nunca teve grant neles).
--
-- Idempotente. Aplicar via Node `pg` (SUPABASE_DB_URL), padrao do projeto.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Alcance amplo: USAGE no schema + SELECT em todas as tabelas/views
--    atuais do public, e DEFAULT PRIVILEGES para as tabelas FUTURAS
--    (decisao Fabio: tabela nova entra automatica; segredo SEMPRE vai pro
--    Vault, nunca pro public).
-- ---------------------------------------------------------------------
grant usage on schema public to lia_sql;
grant select on all tables in schema public to lia_sql;
alter default privileges in schema public grant select on tables to lia_sql;

-- ---------------------------------------------------------------------
-- 2. Denylist de TABELAS: state CSRF transitorio do fluxo OAuth. Zero
--    valor de negocio, sensivel -> revoga por completo.
-- ---------------------------------------------------------------------
revoke select on public.drive_oauth_state from lia_sql;
revoke select on public.gmail_oauth_state from lia_sql;

-- ---------------------------------------------------------------------
-- 3. Denylist de COLUNAS: segredo (token_cifrado) + conteudo bulk
--    (texto/payload/verbatim/embedding/base64). Bulk fica fora da camada
--    SQL por ARQUITETURA: o conteudo de documento e lido pela tool
--    `acervo_ler_documento`; a busca por significado, pela `acervo_search`.
--    NAO sao segredo, mas poluiriam respostas e estouram payload.
--
--    Implementacao robusta: para cada tabela, remove o GRANT table-level e
--    reconcede SELECT apenas nas colunas PERMITIDAS (todas menos as negadas).
--    Le as colunas do catalogo -> resiste a evolucao de schema.
--
--    NOTA: analise_credito (nomus_pessoas) FICA acessivel (decisao Fabio:
--    dado de negocio da DLH). Diretrizes de cotacao/politica FICAM (negocio).
-- ---------------------------------------------------------------------
do $$
declare
  deny jsonb := jsonb_build_object(
    'fontes',          jsonb_build_array('token_cifrado'),     -- SEGREDO
    'documentos',      jsonb_build_array('texto'),             -- bulk (via ler_documento)
    'avisos',          jsonb_build_array('conteudo_verbatim','payload_bruto'),
    'aviso_arquivos',  jsonb_build_array('texto_extraido'),
    'aviso_chunks',    jsonb_build_array('conteudo','embedding'),
    'memoria_chunks',  jsonb_build_array('verbatim','embedding'),
    'nomus_pessoas',   jsonb_build_array('payload_bruto'),
    'nomus_processos', jsonb_build_array('payload_bruto'),
    'config_empresa',  jsonb_build_array('logo_base64')
  );
  tbl     text;
  denied  text[];
  v_cols  text;
begin
  for tbl in select jsonb_object_keys(deny) loop
    denied := array(select jsonb_array_elements_text(deny -> tbl));
    -- remove o privilegio de TABELA (concedido em massa no passo 1)...
    execute format('revoke select on public.%I from lia_sql', tbl);
    -- ...e reconcede SELECT so nas colunas permitidas.
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into v_cols
      from information_schema.columns
      where table_schema = 'public' and table_name = tbl
        and column_name <> all (denied);
    if v_cols is null then
      raise exception 'denylist invalida: tabela % sem colunas restantes', tbl;
    end if;
    execute format('grant select (%s) on public.%I to lia_sql', v_cols, tbl);
  end loop;
end
$$;

-- ---------------------------------------------------------------------
-- 4. BYPASSRLS na role read-only. 26 tabelas do public tem RLS habilitado;
--    sem bypass, lia_sql cai no filtro e ve ZERO linhas no nucleo do RAG
--    (avisos, documentos, processos, pessoas). As views lia.* ja furavam o
--    RLS por ownership; este atributo torna o mesmo comportamento
--    consistente para o acesso direto. Continua READ-ONLY (sem login, sem
--    INSERT/UPDATE/DELETE) e a denylist de grant segue valendo: bypassrls
--    libera LINHAS, nunca tabelas/colunas sem GRANT. Autorizacao na borda.
-- ---------------------------------------------------------------------
alter role lia_sql bypassrls;

-- ---------------------------------------------------------------------
-- 5. RPC: inclui `public` no search_path para a Lia consultar as tabelas
--    diretamente (ex: `select * from produtos`). As views lia.* seguem
--    funcionando (compat) e tem prioridade na resolucao sem schema; para
--    a versao completa, a Lia qualifica `public.<tabela>`. O corpo, os
--    guards e o owner read-only NAO mudam.
-- ---------------------------------------------------------------------
alter function public.executar_sql_lia(text, int)
  set search_path = lia, public, pg_temp;

-- ---------------------------------------------------------------------
-- 6. TRAVA DETERMINISTICA fail-closed: o modelo "tabela nova entra
--    automatica" (passo 1) e fail-OPEN -> uma coluna de segredo criada no
--    futuro ficaria legivel pela Lia ate alguem lembrar de revogar. A
--    regra "segredo nunca pra Lia" precisa estar NO BANCO (SOM), nao na
--    convencao. Este event trigger fecha o buraco.
--
--    Em vez de inspecionar SO o objeto do comando (que NAO reporta o
--    subobjeto coluna em RENAME COLUMN, abrindo bypass), a funcao faz uma
--    VARREDURA DE RECONCILIACAO do catalogo inteiro a cada DDL. Por ser um
--    sweep, cobre de forma uniforme: CREATE TABLE, CREATE TABLE AS,
--    ALTER ADD COLUMN, ALTER RENAME COLUMN, particoes (relkind 'p') e
--    views/matviews. DDL e raro -> custo do sweep e irrelevante.
--
--    (a) TABELAS: para toda tabela de public com coluna de nome de segredo,
--        troca o grant de TABELA por grant das colunas PERMITIDAS (preserva
--        a denylist de bulk via has_column_privilege). Nao bloqueia o DDL,
--        so corta o acesso da Lia.
--    (b) VIEWS/MATVIEWS: uma view roda com o privilegio do OWNER, entao
--        furaria a protecao por coluna. Revoga da Lia toda view que
--        referencie QUALQUER coluna-base que ela nao pode ler (segredo ou
--        bulk). Views sobre dado 100% de negocio permanecem legiveis.
-- ---------------------------------------------------------------------
create or replace function public.lia_reconcile_segredos()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $fn$
declare
  pat constant text := '(secret|token|senha|password|cifrado|api_key|refresh_token)';
  r record;
  v_cols text;
begin
  -- (a) tabelas (comuns + particionadas) com coluna de nome de segredo.
  for r in
    select c.relname as tbl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and exists (
          select 1 from information_schema.columns col
            where col.table_schema = 'public' and col.table_name = c.relname
              and col.column_name ~* pat)
  loop
    -- conjunto VISIVEL atual da Lia, MENOS as colunas de segredo. Tabela
    -- nova: ve tudo via grant de tabela -> sobra tudo menos segredo. Tabela
    -- de denylist: bulk ja invisivel -> permanece fora.
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into v_cols
      from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl
        and column_name !~* pat
        and has_column_privilege('lia_sql', format('public.%I', r.tbl)::regclass, column_name, 'SELECT');
    execute format('revoke select on public.%I from lia_sql', r.tbl);
    if v_cols is not null then
      execute format('grant select (%s) on public.%I to lia_sql', v_cols, r.tbl);
    end if;
  end loop;

  -- (b) views/matviews de public que referenciam coluna-base proibida.
  for r in
    select distinct dv.relname as vname
      from pg_depend d
      join pg_rewrite rw on rw.oid = d.objid
      join pg_class dv on dv.oid = rw.ev_class
      join pg_class src on src.oid = d.refobjid
      join pg_namespace nv on nv.oid = dv.relnamespace
      where nv.nspname = 'public'
        and dv.relkind in ('v', 'm')
        and d.classid = 'pg_rewrite'::regclass
        and d.refclassid = 'pg_class'::regclass
        and d.refobjsubid > 0
        and src.relkind in ('r', 'p', 'v', 'm')
        and dv.oid <> src.oid
        and not has_column_privilege('lia_sql', src.oid, d.refobjsubid::int2, 'select')
  loop
    execute format('revoke select on public.%I from lia_sql', r.vname);
  end loop;
end
$fn$;

-- wrapper de event trigger (a logica vive na funcao reutilizavel acima, que
-- tambem e chamada uma vez abaixo para reconciliar os objetos JA existentes).
create or replace function public.lia_protege_segredo()
returns event_trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $et$
begin
  perform public.lia_reconcile_segredos();
end
$et$;

drop event trigger if exists trg_lia_protege_segredo;
create event trigger trg_lia_protege_segredo
  on ddl_command_end
  when tag in (
    'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE',
    'CREATE VIEW', 'ALTER VIEW', 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW'
  )
  execute function public.lia_protege_segredo();

comment on function public.lia_reconcile_segredos() is
  'Sweep fail-closed (SOM): varre o catalogo public e (a) corta do lia_sql colunas de nome de segredo (secret|token|senha|password|cifrado|api_key|refresh_token) trocando grant de tabela por grant das colunas permitidas; (b) revoga views/matviews que referenciem coluna-base proibida. Chamada pelo event trigger trg_lia_protege_segredo a cada DDL e uma vez na migration para os objetos existentes.';

comment on function public.lia_protege_segredo() is
  'Event trigger wrapper: chama lia_reconcile_segredos() ao fim de cada CREATE/ALTER de tabela ou view em public. Garante "segredo nunca pra Lia" deterministicamente no banco. Nao bloqueia DDL.';

-- reconcilia os objetos JA existentes (idempotente; cobre qualquer view ou
-- coluna de segredo que ja exista antes do trigger entrar em vigor).
select public.lia_reconcile_segredos();

comment on function public.executar_sql_lia(text, int) is
  'Tool #4 RAG: executa um SELECT read-only da Lia sobre o substrato (schema public + views curadas lia.*) sob travas deterministicas (owner lia_sql read-only; SELECT/WITH-only; sem ";"; statement_timeout 5s; LIMIT 1000). Segredo (token_cifrado, oauth_state) e bulk (texto/payload/verbatim/embedding/base64) ficam fora por GRANT. Vault/cron/auth/storage inalcancaveis. Autorizacao na borda; somente service_role executa.';
