-- =====================================================================
-- Ledger de registros por execucao: o que CADA coleta de fato fez.
--
-- O recorte da guia "Dados" por execucao usava a JANELA DE TEMPO da execucao
-- sobre captado_em (migration 20260629120000). Isso so enxerga registros
-- INEDITOS: captado_em e a PRIMEIRA captacao (imutavel). Uma execucao que
-- apenas RE-VARRE (backfill, re-scan, mudanca de etapa) nao cria captado_em
-- novo, entao caia fora da janela -> o clique no Nomus "nao trazia nada".
--
-- Aqui cada execucao passa a registrar, item a item, o EFEITO que teve sobre
-- cada registro: 'novo' (1a vez que entrou) ou 'atualizado' (ja existia e foi
-- mexido). O clique na execucao cruza ESTE ledger (nao a janela) e mostra
-- exatamente os registros daquela rodada, rotulados novo vs atualizado.
--
-- D3 / recurso na PK: a lista mestra (vw_coleta_registros_mestra) foi
-- re-ancorada nos registros-fonte (migration 20260629100000) e ganhou a
-- coluna `recurso`. A identidade de um registro mestre e a TRIPLA
-- (fonte, recurso, registro_origem_id) — fonte='nomus' sozinha e ambigua
-- (processos vs pessoas compartilham nomus_id). Para o INNER JOIN do recorte
-- por execucao casar exatamente uma linha da view, o ledger precisa carregar
-- o `recurso`. Como a chave do ledger muda, NAO da para ALTER + backfill
-- (recurso e NOT NULL e a PK do Postgres nao aceita NULL): fazemos DROP &
-- RECREATE (efetivamente TRUNCATE). Execucoes antigas perdem o recorte ate a
-- proxima coleta — custo unico aceito (Nomus/Effecti ja estavam vazias pelo
-- bug da janela). Tudo dentro de UMA transacao (a migration inteira), a prova
-- de write-backs concorrentes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- DROP & RECREATE do ledger. PK composta agora inclui `recurso` =
-- (execucao_id, fonte, recurso, registro_origem_id), a MESMA granularidade
-- da lista mestra re-ancorada -> INNER JOIN exato pela tripla. CASCADE
-- defensivo. ON DELETE CASCADE: apagar a execucao leva o ledger junto.
-- ---------------------------------------------------------------------
drop table if exists public.execucao_registros cascade;

create table public.execucao_registros (
  execucao_id         uuid not null references public.execucoes(id) on delete cascade,
  fonte               text not null,                          -- effecti | nomus | drive | gmail
  recurso             text not null,                          -- avisos | processos | pessoas | mensagens | arquivos
  registro_origem_id  text not null,                          -- effecti_id | nomus_id | message_id | file_id
  efeito              text not null check (efeito in ('novo', 'atualizado')),
  created_at          timestamptz not null default now(),
  primary key (execucao_id, fonte, recurso, registro_origem_id)
);

comment on table public.execucao_registros is
  'Ledger do efeito de cada execucao de coleta sobre cada registro (novo|atualizado), na granularidade (fonte, recurso, registro_origem_id) da lista mestra re-ancorada. Cruzado pelo clique numa execucao para recortar a guia Dados.';

-- Cruzamento com a view mestra parte da tripla (fonte, recurso,
-- registro_origem_id); o filtro por execucao usa a PK (execucao_id leftmost).
-- Indice auxiliar para casar a identidade de juncao pelo lado da view.
create index if not exists idx_execucao_registros_fonte_recurso_registro
  on public.execucao_registros (fonte, recurso, registro_origem_id);

-- ---------------------------------------------------------------------
-- So o service_role (Edge) escreve/le este ledger; anon/authenticated nao.
-- ---------------------------------------------------------------------
revoke all on public.execucao_registros from anon, authenticated;
grant select, insert, update, delete on public.execucao_registros to service_role;

-- ---------------------------------------------------------------------
-- Limpeza dos overloads anteriores de coleta_registros_listar para nao
-- deixar sobrecargas ambiguas no catalogo: o de 7 args (20260629100000) e o
-- de 9 args com a janela (20260629120000). A nova assinatura tem 6 args e
-- retorna uma TABLE (inclui `efeito`), incompativel com `setof view` — exige
-- DROP antes do CREATE.
-- ---------------------------------------------------------------------
drop function if exists public.coleta_registros_listar(text, text, boolean, text, timestamptz, text, integer);
drop function if exists public.coleta_registros_listar(text, text, boolean, text, timestamptz, text, integer, timestamptz, timestamptz);

-- ---------------------------------------------------------------------
-- coleta_registros_listar: uma pagina (keyset captado_em DESC, id_composto
-- ASC) da lista mestra cumulativa, refletindo o universo da view re-ancorada
-- (Effecti inclui sem anexo; Nomus = processos + pessoas). Retorna as colunas
-- da view + `efeito` (sempre NULL nesta rota; o efeito so existe no recorte
-- por execucao). Filtros fonte/status em SQL; busca via ilike com curingas
-- escapados; clamp do limite em [1, 200].
-- ---------------------------------------------------------------------
create function public.coleta_registros_listar(
  p_fonte text default null,
  p_status text default null,
  p_busca text default null,
  p_cursor_captado_em timestamptz default null,
  p_cursor_id_composto text default null,
  p_limit integer default 50
)
returns table (
  fonte                      text,
  recurso                    text,
  registro_origem_id         text,
  id_composto                text,
  titulo_curto               text,
  busca_texto                text,
  captado_em                 timestamptz,
  qtd_documentos             bigint,
  qtd_pendentes              bigint,
  qtd_erros                  bigint,
  qtd_ignorado               bigint,
  rep_id                     uuid,
  rep_nome_anexo             text,
  rep_documento_id           uuid,
  status_indexacao_agregado  text,
  efeito                     text
)
language sql
stable
as $$
  select
    v.fonte,
    v.recurso,
    v.registro_origem_id,
    v.id_composto,
    v.titulo_curto,
    v.busca_texto,
    v.captado_em,
    v.qtd_documentos,
    v.qtd_pendentes,
    v.qtd_erros,
    v.qtd_ignorado,
    v.rep_id,
    v.rep_nome_anexo,
    v.rep_documento_id,
    v.status_indexacao_agregado,
    null::text as efeito
  from public.vw_coleta_registros_mestra v
  where (p_fonte is null or v.fonte = p_fonte)
    and (p_status is null or v.status_indexacao_agregado = p_status)
    and (
      p_busca is null
      -- Curingas %, _ e o proprio \ escapados na borda; termo limitado a 200
      -- chars. busca_texto ja e lowercase; ilike garante case-insensitive.
      or v.busca_texto ilike
           '%' || replace(replace(replace(left(p_busca, 200), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           escape '\'
    )
    and (
      p_cursor_captado_em is null
      or v.captado_em < p_cursor_captado_em
      or (v.captado_em = p_cursor_captado_em and v.id_composto > p_cursor_id_composto)
    )
  order by v.captado_em desc, v.id_composto asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function public.coleta_registros_listar is
  'Uma pagina (keyset captado_em DESC, id_composto ASC) da lista mestra cumulativa da Coleta, refletindo a view re-ancorada. Colunas da view + efeito (NULL nesta rota). Filtros fonte/status e busca (ilike escapado, 200 chars) em SQL; limite com clamp [1,200]. Chamada pela Edge coleta-registros via service_role.';

revoke all on function public.coleta_registros_listar(text, text, text, timestamptz, text, integer) from anon, authenticated;
grant execute on function public.coleta_registros_listar(text, text, text, timestamptz, text, integer) to service_role;

-- ---------------------------------------------------------------------
-- Pagina por EXECUCAO: a lista mestra recortada nos registros que ESTA
-- execucao tocou, carregando o efeito (novo|atualizado). INNER JOIN ao ledger
-- pela TRIPLA (fonte, recurso, registro_origem_id) garante "so o que a
-- execucao fez" e casa exatamente uma linha da view re-ancorada (sem a tripla,
-- processos e pessoas Nomus se cruzariam). Mesmo keyset e mesmas colunas do
-- _listar, mas efeito aqui e NAO-NULL. A assinatura antiga de 4 args sai.
-- ---------------------------------------------------------------------
drop function if exists public.coleta_registros_por_execucao(uuid, timestamptz, text, integer);

create function public.coleta_registros_por_execucao(
  p_execucao_id uuid,
  p_fonte text default null,
  p_status text default null,
  p_busca text default null,
  p_cursor_captado_em timestamptz default null,
  p_cursor_id_composto text default null,
  p_limit integer default 50
)
returns table (
  fonte                      text,
  recurso                    text,
  registro_origem_id         text,
  id_composto                text,
  titulo_curto               text,
  busca_texto                text,
  captado_em                 timestamptz,
  qtd_documentos             bigint,
  qtd_pendentes              bigint,
  qtd_erros                  bigint,
  qtd_ignorado               bigint,
  rep_id                     uuid,
  rep_nome_anexo             text,
  rep_documento_id           uuid,
  status_indexacao_agregado  text,
  efeito                     text
)
language sql
stable
as $$
  select
    v.fonte,
    v.recurso,
    v.registro_origem_id,
    v.id_composto,
    v.titulo_curto,
    v.busca_texto,
    v.captado_em,
    v.qtd_documentos,
    v.qtd_pendentes,
    v.qtd_erros,
    v.qtd_ignorado,
    v.rep_id,
    v.rep_nome_anexo,
    v.rep_documento_id,
    v.status_indexacao_agregado,
    r.efeito
  from public.execucao_registros r
  join public.vw_coleta_registros_mestra v
    on v.fonte = r.fonte
   and v.recurso = r.recurso
   and v.registro_origem_id = r.registro_origem_id
  where r.execucao_id = p_execucao_id
    and (p_fonte is null or v.fonte = p_fonte)
    and (p_status is null or v.status_indexacao_agregado = p_status)
    and (
      p_busca is null
      or v.busca_texto ilike
           '%' || replace(replace(replace(left(p_busca, 200), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           escape '\'
    )
    and (
      p_cursor_captado_em is null
      or v.captado_em < p_cursor_captado_em
      or (v.captado_em = p_cursor_captado_em and v.id_composto > p_cursor_id_composto)
    )
  order by v.captado_em desc, v.id_composto asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function public.coleta_registros_por_execucao is
  'Uma pagina (keyset captado_em DESC, id_composto ASC) da lista mestra recortada nos registros que a execucao p_execucao_id tocou, com o efeito (novo|atualizado) por registro. INNER JOIN ao ledger pela tripla (fonte, recurso, registro_origem_id). Chamada pela Edge coleta-registros via service_role.';

revoke all on function public.coleta_registros_por_execucao(uuid, text, text, text, timestamptz, text, integer) from anon, authenticated;
grant execute on function public.coleta_registros_por_execucao(uuid, text, text, text, timestamptz, text, integer) to service_role;

-- ---------------------------------------------------------------------
-- Contagens por fonte (cumulativas, independentes de filtro/paginacao) para
-- os chips da toolbar. Reflete AUTOMATICAMENTE o universo da view re-ancorada:
-- nomus soma processos + pessoas e inclui registros sem anexo. O LEFT JOIN
-- sobre a lista fixa de 4 fontes garante sempre 4 linhas (zero quando vazia).
-- A coluna passou de `total` para `qtd`: alterar o nome do output exige DROP.
-- ---------------------------------------------------------------------
drop function if exists public.coleta_registros_contagens();

create function public.coleta_registros_contagens()
returns table (fonte text, qtd bigint)
language sql
stable
as $$
  select f.fonte, coalesce(c.qtd, 0)::bigint as qtd
  from (values ('effecti'::text), ('nomus'), ('gmail'), ('drive')) as f(fonte)
  left join (
    select v.fonte, count(*)::bigint as qtd
    from public.vw_coleta_registros_mestra v
    group by v.fonte
  ) c on c.fonte = f.fonte
  order by f.fonte;
$$;

comment on function public.coleta_registros_contagens is
  'Total de registros mestres por fonte (4 linhas: effecti/nomus/gmail/drive; nomus = processos + pessoas, inclui sem anexo) para os chips da toolbar da guia Dados.';

revoke all on function public.coleta_registros_contagens() from anon, authenticated;
grant execute on function public.coleta_registros_contagens() to service_role;

-- =====================================================================
-- Write-back de efeito nas funcoes de descoberta Gmail/Drive (a propria
-- persistencia dessas fontes). Cada uma acha a execucao em_andamento da sua
-- fonte e grava o efeito por registro, agora carregando o `recurso` e o
-- on conflict pela NOVA PK (execucao_id, fonte, recurso, registro_origem_id).
-- Effecti/Nomus gravam no Edge.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Gmail: imutavel (so 'novo'), recurso='mensagens'. Resolve a execucao aberta
-- da fonte gmail e, para cada message_id realmente inserido (DISTINCT, pois
-- corpo+anexos compartilham o message_id), grava efeito 'novo'. Sem execucao
-- aberta o ledger e pulado (descoberta avulsa nao quebra). Restante igual.
-- ---------------------------------------------------------------------
create or replace function public.descobrir_vinculos_gmail(
  p_itens jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_inseridos integer;
  v_execucao_id uuid;
begin
  if jsonb_typeof(p_itens) <> 'array' then
    return 0;
  end if;

  -- Execucao em_andamento da fonte gmail (single-flight: no maximo uma).
  select e.id into v_execucao_id
  from public.execucoes e
  join public.fontes f on f.id = e.fonte_id
  where f.tipo = 'gmail' and e.status = 'em_andamento'
  order by e.inicio desc
  limit 1;

  with itens as (
    select
      nullif(x ->> 'message_id', '')                                   as message_id,
      nullif(x ->> 'thread_id', '')                                    as thread_id,
      coalesce(nullif(x ->> 'tipo', ''), 'anexo')                      as tipo,
      x ->> 'nome'                                                     as nome,
      nullif(x ->> 'attachment_id', '')                               as attachment_id,
      nullif(lower(regexp_replace(coalesce(x ->> 'extensao', ''), '^\.', '')), '') as ext,
      nullif(btrim(coalesce(x ->> 'assunto', '')), '')                 as assunto
    from jsonb_array_elements(p_itens) x
    where nullif(x ->> 'message_id', '') is not null                   -- sem id natural = inobtenivel
      and x ->> 'nome' is not null                                     -- nome distingue corpo vs anexos
  ),
  ins as (
    insert into public.documento_vinculos
      (fonte, registro_origem_id, nome_anexo, ref_obtencao, status_extracao)
    select 'gmail',
           itens.message_id,
           itens.nome,
           jsonb_build_object(
             'message_id', itens.message_id,
             'thread_id', itens.thread_id,
             'tipo', itens.tipo,
             'attachment_id', itens.attachment_id,
             'nome', itens.nome,
             'extensao', itens.ext,
             'assunto', itens.assunto
           ),
           'pendente'
    from itens
    on conflict (fonte, registro_origem_id, nome_anexo) do nothing
    returning registro_origem_id
  ),
  led as (
    -- 1 linha de ledger por message_id inedito (corpo+anexos colapsam no PK).
    insert into public.execucao_registros (execucao_id, fonte, recurso, registro_origem_id, efeito)
    select v_execucao_id, 'gmail', 'mensagens', i.registro_origem_id, 'novo'
    from (select distinct registro_origem_id from ins) i
    where v_execucao_id is not null
    on conflict (execucao_id, fonte, recurso, registro_origem_id) do nothing
    returning 1
  )
  select count(*) into v_inseridos from ins;
  return v_inseridos;
end;
$$;

revoke all on function public.descobrir_vinculos_gmail(jsonb)
  from public, anon, authenticated;
grant execute on function public.descobrir_vinculos_gmail(jsonb)
  to service_role;

-- ---------------------------------------------------------------------
-- Drive: arquivo editavel, recurso='arquivos'. Resolve a execucao aberta da
-- fonte drive e grava 'novo' no insert de file_id inedito e 'atualizado' na
-- reabertura (assinatura mudou). Assinatura igual = no-op, sem ledger. Sem
-- execucao aberta = pula o ledger. Ambos os inserts no ledger carregam o
-- recurso e o on conflict pela nova PK. Restante igual ao original.
-- ---------------------------------------------------------------------
create or replace function public.descobrir_vinculos_drive(
  p_arquivos jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_item        jsonb;
  v_file_id     text;
  v_nome        text;
  v_ext         text;
  v_assin       text;
  v_ref         jsonb;
  v_existente   public.documento_vinculos%rowtype;
  v_afetados    integer := 0;
  v_execucao_id uuid;
begin
  if jsonb_typeof(p_arquivos) <> 'array' then
    return 0;
  end if;

  -- Execucao em_andamento da fonte drive (single-flight: no maximo uma).
  select e.id into v_execucao_id
  from public.execucoes e
  join public.fontes f on f.id = e.fonte_id
  where f.tipo = 'drive' and e.status = 'em_andamento'
  order by e.inicio desc
  limit 1;

  for v_item in select * from jsonb_array_elements(p_arquivos)
  loop
    v_file_id := nullif(v_item ->> 'file_id', '');
    if v_file_id is null then
      continue;                                   -- sem id natural = inobtenivel
    end if;
    v_nome  := v_item ->> 'nome';
    v_ext   := nullif(lower(regexp_replace(coalesce(v_item ->> 'extensao', ''), '^\.', '')), '');
    v_assin := nullif(v_item ->> 'assinatura', '');
    v_ref := jsonb_build_object(
      'file_id', v_file_id,
      'nome', v_nome,
      'assinatura', v_assin,
      'mimeType', v_item ->> 'mimeType',
      'extensao', v_ext
    );

    -- Identidade por file_id (NAO por nome): cobre rename.
    select * into v_existente
    from public.documento_vinculos
    where fonte = 'drive' and registro_origem_id = v_file_id
    limit 1;

    if not found then
      insert into public.documento_vinculos
        (fonte, registro_origem_id, nome_anexo, ref_obtencao, status_extracao)
      values ('drive', v_file_id, v_nome, v_ref, 'pendente');
      v_afetados := v_afetados + 1;
      if v_execucao_id is not null then
        insert into public.execucao_registros (execucao_id, fonte, recurso, registro_origem_id, efeito)
        values (v_execucao_id, 'drive', 'arquivos', v_file_id, 'novo')
        on conflict (execucao_id, fonte, recurso, registro_origem_id) do nothing;
      end if;

    elsif v_assin is not null
      and v_assin is distinct from (v_existente.ref_obtencao ->> 'assinatura') then
      -- Arquivo mudou: reabre para re-extracao (desfaz o vinculo ao doc antigo).
      update public.documento_vinculos
      set status_extracao = 'pendente',
          documento_id     = null,
          erro             = null,
          nome_anexo       = v_nome,
          ref_obtencao     = v_ref
      where id = v_existente.id;
      v_afetados := v_afetados + 1;
      if v_execucao_id is not null then
        insert into public.execucao_registros (execucao_id, fonte, recurso, registro_origem_id, efeito)
        values (v_execucao_id, 'drive', 'arquivos', v_file_id, 'atualizado')
        on conflict (execucao_id, fonte, recurso, registro_origem_id) do nothing;
      end if;
    end if;
    -- assinatura igual: nada a fazer (idempotente, nem re-baixa).
  end loop;

  return v_afetados;
end;
$$;

revoke all on function public.descobrir_vinculos_drive(jsonb)
  from public, anon, authenticated;
grant execute on function public.descobrir_vinculos_drive(jsonb)
  to service_role;
