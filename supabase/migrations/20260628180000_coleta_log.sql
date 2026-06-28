-- =====================================================================
-- coleta_log — stream de log linha-a-linha da coleta, para o console ao vivo
-- da guia "Logs" do submodulo Coleta (decisao Fabio 2026-06-28).
--
-- POR QUE EXISTE:
--   A guia Execucoes mostra o STATUS de cada coleta (etapa + contadores), mas
--   o Fabio quer ver, em tempo real, o que esta acontecendo linha a linha
--   (estilo terminal). As coletas Edge (Effecti/Gmail/Drive) ja imprimem isso
--   em console.log, mas o destino e o log da Edge, invisivel ao cockpit. O PC
--   (Nomus/Tika) produz stdout/stderr reais nos wrappers .ps1. Esta tabela e o
--   DESTINO COMUM dessas linhas: cada fonte grava aqui e o cockpit assina via
--   Supabase Realtime (mesmo mecanismo que move a barra de progresso ao vivo).
--
-- QUEM ESCREVE:
--   Edge de coleta (service_role)  -> helper _shared/coleta-log.ts, vinculando
--                                     execucao_id.
--   PC local (X-Cron-Secret)       -> Edge coleta-log-ingestar, vinculando
--                                     comando_id (o PC nao conhece execucao_id).
--   Leitura inicial do cockpit     -> Edge coleta-log (service_role, sessao).
--   Stream ao vivo do cockpit      -> Supabase Realtime (JWT do usuario, RLS).
--
-- RLS: habilitada COM a policy is_conta_autorizada (igual execucoes). O
--   Realtime avalia essa policy no canal autenticado; SEM ela o motor de RLS
--   descarta os eventos e o console fica mudo. Escrita e service_role (bypassa
--   RLS) ou via Edge; a policy serve a leitura/realtime do usuario autorizado.
--
-- VOLUME: granularidade item-a-item -> retencao curta. Um job pg_cron poda
--   linhas com mais de 48h (console e janela do agora, nao historico). INSERT-
--   only: a replica identity default ja carrega a linha nova no evento de
--   Realtime (FULL so seria necessario para UPDATE/DELETE, que aqui nao ocorrem).
--
-- Idempotente (if not exists / guardas). Aplicar via Node `pg` (db push quebrado).
-- =====================================================================

create table if not exists public.coleta_log (
  -- bigint identity = ordem natural do console (monotonica, melhor que uuid
  -- para ordenar e paginar linhas de terminal).
  id           bigint generated always as identity primary key,
  -- Vinculo da linha a sua coleta. Edge: execucao_id. PC: comando_id. Ambos
  -- nullable e independentes (origens distintas); 'sistema' pode ter os dois null.
  execucao_id  uuid references public.execucoes(id) on delete cascade,
  comando_id   uuid references public.comando_local(id) on delete cascade,
  -- Fonte da linha, para o filtro do console.
  origem       text not null
                 check (origem in ('effecti', 'nomus', 'gmail', 'drive', 'tika', 'sistema')),
  -- Nivel da linha (cor no console). 'erro' tambem aparece na tela de Erros.
  nivel        text not null default 'info' check (nivel in ('info', 'warn', 'erro')),
  mensagem     text not null,
  criado_em    timestamptz not null default now()
);

comment on table public.coleta_log is
  'Stream de log linha-a-linha da coleta para o console ao vivo da guia Logs. Cada fonte grava (Edge via service_role com execucao_id; PC via Edge coleta-log-ingestar com comando_id); o cockpit le a carga inicial pela Edge coleta-log e o stream via Supabase Realtime (RLS is_conta_autorizada). Retencao 48h via pg_cron (coleta-log-prune).';

-- Carga inicial do console: ultimas N linhas por recencia (e por fonte).
create index if not exists coleta_log_criado_em_idx
  on public.coleta_log (criado_em desc);
create index if not exists coleta_log_origem_idx
  on public.coleta_log (origem, criado_em desc);

-- RLS: mesma policy de acesso pleno do usuario autorizado que execucoes usa
-- (o Realtime respeita esta policy no canal autenticado).
alter table public.coleta_log enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'coleta_log'
      and policyname = 'coleta_log_acesso_autorizado'
  ) then
    create policy coleta_log_acesso_autorizado on public.coleta_log
      for all using (public.is_conta_autorizada())
      with check (public.is_conta_autorizada());
  end if;
end;
$$;

-- Publication do Realtime: torna a tabela membro (idempotente), igual execucoes.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'coleta_log'
     )
  then
    alter publication supabase_realtime add table public.coleta_log;
  end if;
end;
$$;

-- Retencao: poda horaria das linhas com mais de 48h (console = janela do agora).
-- So agenda se o pg_cron existir; re-agenda de forma idempotente.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'coleta-log-prune') then
      perform cron.unschedule('coleta-log-prune');
    end if;
    perform cron.schedule(
      'coleta-log-prune',
      '7 * * * *',
      $cmd$ delete from public.coleta_log where criado_em < now() - interval '48 hours' $cmd$
    );
  end if;
end;
$$;
