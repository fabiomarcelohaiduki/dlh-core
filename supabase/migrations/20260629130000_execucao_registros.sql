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
-- Chave do ledger = (execucao_id, fonte, registro_origem_id), a MESMA
-- granularidade da lista mestra (vw_coleta_registros_mestra) -> INNER JOIN
-- exato. Effecti/Nomus gravam o efeito no Edge (onde ja decidem inserido/
-- atualizado por registro); Gmail/Drive gravam aqui dentro das funcoes de
-- descoberta (que sao a propria persistencia), achando a execucao aberta da
-- fonte (single-flight: 1 execucao em_andamento por fonte).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabela ledger. PK composta = idempotencia: re-rodar a mesma descoberta
-- na mesma execucao nao duplica linha. ON DELETE CASCADE: apagar a execucao
-- leva o ledger junto (o ledger so faz sentido com a execucao viva).
-- ---------------------------------------------------------------------
create table if not exists public.execucao_registros (
  execucao_id         uuid not null references public.execucoes(id) on delete cascade,
  fonte               text not null,                          -- effecti | nomus | drive | gmail
  registro_origem_id  text not null,                          -- effecti_id | nomus_id | file_id | message_id
  efeito              text not null check (efeito in ('novo', 'atualizado')),
  criado_em           timestamptz not null default now(),
  primary key (execucao_id, fonte, registro_origem_id)
);

comment on table public.execucao_registros is
  'Ledger do efeito de cada execucao de coleta sobre cada registro (novo|atualizado), na granularidade (fonte, registro_origem_id) da lista mestra. Cruzado pelo clique numa execucao para recortar a guia Dados.';

-- Cruzamento com a view mestra parte do (fonte, registro_origem_id); o filtro
-- por execucao usa a PK (execucao_id leftmost). Indice auxiliar para a juncao
-- pelo lado da view (quando a execucao tem muitos registros).
create index if not exists idx_execucao_registros_fonte_registro
  on public.execucao_registros (fonte, registro_origem_id);

-- ---------------------------------------------------------------------
-- So o service_role (Edge) escreve/le este ledger; anon/authenticated nao.
-- ---------------------------------------------------------------------
revoke all on public.execucao_registros from anon, authenticated;
grant select, insert, update, delete on public.execucao_registros to service_role;

-- ---------------------------------------------------------------------
-- coleta_registros_listar volta para a assinatura limpa de 7 args: a janela
-- de captacao (p_captado_de/p_captado_ate, a tentativa que falhou no Nomus)
-- sai de cena, substituida pelo recorte por ledger abaixo. Sem deixar duas
-- sobrecargas ambiguas no catalogo.
-- ---------------------------------------------------------------------
drop function if exists public.coleta_registros_listar(text, text, boolean, text, timestamptz, text, integer, timestamptz, timestamptz);

create or replace function public.coleta_registros_listar(
  p_fonte text default null,
  p_status text default null,
  p_tem_erro boolean default false,
  p_busca text default null,
  p_cursor_captado timestamptz default null,
  p_cursor_id text default null,
  p_limit integer default 25
)
returns setof public.vw_coleta_registros_mestra
language sql
stable
as $$
  select *
  from public.vw_coleta_registros_mestra v
  where (p_fonte is null or v.fonte = p_fonte)
    and (p_status is null or v.status_indexacao_agregado = p_status)
    and (not p_tem_erro or v.qtd_erros > 0)
    and (p_busca is null or v.busca_texto like '%' || lower(p_busca) || '%')
    and (
      p_cursor_captado is null
      or v.captado_em < p_cursor_captado
      or (v.captado_em = p_cursor_captado and v.id_composto > p_cursor_id)
    )
  order by v.captado_em desc, v.id_composto asc
  limit greatest(1, least(p_limit, 200));
$$;

comment on function public.coleta_registros_listar is
  'Uma pagina (keyset captado_em DESC, id_composto ASC) da lista mestra da Coleta, com filtros fonte/status/tem_erro/busca em SQL. Chamada pela Edge coleta-registros via service_role.';

revoke all on function public.coleta_registros_listar(text, text, boolean, text, timestamptz, text, integer) from anon, authenticated;
grant execute on function public.coleta_registros_listar(text, text, boolean, text, timestamptz, text, integer) to service_role;

-- ---------------------------------------------------------------------
-- Pagina por EXECUCAO: a lista mestra recortada nos registros que ESTA
-- execucao tocou, carregando o efeito (novo|atualizado). INNER JOIN ao
-- ledger garante "so o que a execucao fez". Mesmo keyset (captado_em DESC,
-- id_composto ASC) e mesmas colunas da view + efeito.
-- ---------------------------------------------------------------------
create or replace function public.coleta_registros_por_execucao(
  p_execucao_id uuid,
  p_cursor_captado timestamptz default null,
  p_cursor_id text default null,
  p_limit integer default 25
)
returns table (
  id_composto                text,
  fonte                      text,
  registro_origem_id         text,
  captado_em                 timestamptz,
  qtd_documentos             bigint,
  qtd_pendentes              bigint,
  qtd_erros                  bigint,
  qtd_ignorado               bigint,
  status_indexacao_agregado  text,
  titulo_curto               text,
  rep_id                     uuid,
  rep_nome_anexo             text,
  rep_documento_id           uuid,
  busca_texto                text,
  efeito                     text
)
language sql
stable
as $$
  select
    v.id_composto,
    v.fonte,
    v.registro_origem_id,
    v.captado_em,
    v.qtd_documentos,
    v.qtd_pendentes,
    v.qtd_erros,
    v.qtd_ignorado,
    v.status_indexacao_agregado,
    v.titulo_curto,
    v.rep_id,
    v.rep_nome_anexo,
    v.rep_documento_id,
    v.busca_texto,
    r.efeito
  from public.execucao_registros r
  join public.vw_coleta_registros_mestra v
    on v.fonte = r.fonte and v.registro_origem_id = r.registro_origem_id
  where r.execucao_id = p_execucao_id
    and (
      p_cursor_captado is null
      or v.captado_em < p_cursor_captado
      or (v.captado_em = p_cursor_captado and v.id_composto > p_cursor_id)
    )
  order by v.captado_em desc, v.id_composto asc
  limit greatest(1, least(p_limit, 200));
$$;

comment on function public.coleta_registros_por_execucao is
  'Uma pagina (keyset captado_em DESC, id_composto ASC) da lista mestra recortada nos registros que a execucao p_execucao_id tocou, com o efeito (novo|atualizado) por registro. INNER JOIN ao ledger execucao_registros. Chamada pela Edge coleta-registros via service_role.';

revoke all on function public.coleta_registros_por_execucao(uuid, timestamptz, text, integer) from anon, authenticated;
grant execute on function public.coleta_registros_por_execucao(uuid, timestamptz, text, integer) to service_role;

-- =====================================================================
-- Write-back de efeito nas funcoes de descoberta Gmail/Drive (a propria
-- persistencia dessas fontes). Cada uma acha a execucao em_andamento da sua
-- fonte e grava o efeito por registro. Effecti/Nomus gravam no Edge.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Gmail: imutavel (so 'novo'). Resolve a execucao aberta da fonte gmail e,
-- para cada message_id realmente inserido (DISTINCT, pois corpo+anexos
-- compartilham o message_id), grava efeito 'novo'. Sem execucao aberta o
-- ledger e pulado (descoberta avulsa nao quebra). Restante igual ao original.
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
    insert into public.execucao_registros (execucao_id, fonte, registro_origem_id, efeito)
    select v_execucao_id, 'gmail', i.registro_origem_id, 'novo'
    from (select distinct registro_origem_id from ins) i
    where v_execucao_id is not null
    on conflict (execucao_id, fonte, registro_origem_id) do nothing
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
-- Drive: arquivo editavel. Resolve a execucao aberta da fonte drive e grava
-- 'novo' no insert de file_id inedito e 'atualizado' na reabertura (assinatura
-- mudou). Assinatura igual = no-op, sem ledger. Sem execucao aberta = pula o
-- ledger. Restante (logica de descoberta) igual ao original.
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
        insert into public.execucao_registros (execucao_id, fonte, registro_origem_id, efeito)
        values (v_execucao_id, 'drive', v_file_id, 'novo')
        on conflict (execucao_id, fonte, registro_origem_id) do nothing;
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
        insert into public.execucao_registros (execucao_id, fonte, registro_origem_id, efeito)
        values (v_execucao_id, 'drive', v_file_id, 'atualizado')
        on conflict (execucao_id, fonte, registro_origem_id) do nothing;
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
