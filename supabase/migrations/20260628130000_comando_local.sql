-- =====================================================================
-- comando_local — fila de comandos que o COCKPIT enfileira e o PC LOCAL
-- (servico de poll) executa.
--
-- POR QUE EXISTE (decisao Fabio 2026-06-28):
--   Pos-bloqueio do GitHub Actions, a coleta Nomus e a extracao Tika/OCR
--   migraram para este PC (Agendador do Windows). O Agendador roda em
--   horario fixo; nao ha como o Fabio DISPARAR essas tarefas pelo cockpit.
--   Solucao: o Supabase vira o QUADRO DE AVISOS. O cockpit insere um comando
--   'pendente'; um servico de poll no PC pega o comando (atomico), roda o
--   wrapper .ps1 correspondente e devolve o status/resultado. O cockpit so
--   le o status; o PC e quem executa.
--
-- COMANDOS SUPORTADOS:
--   nomus-processos | nomus-pessoas -> coletar-nomus.ps1 -Recurso <r>
--   tika-ocr                        -> extrair-tika.ps1 (modo rapido + OCR)
--
-- CICLO: pendente -> executando (pego pelo PC) -> concluido | erro.
--
-- Acesso server-side: RLS habilitada, sem policies. O cockpit grava/le pela
--   Edge comando-local-enfileirar (service_role) e o PC pega/sela pela Edge
--   comando-local-fila (service_role). Nenhum acesso anon/authenticated direto.
--
-- Idempotente (if not exists), conforme norma de migration.
-- =====================================================================

create table if not exists public.comando_local (
  id            uuid primary key default gen_random_uuid(),
  -- Comando logico; o PC mapeia para o wrapper .ps1 correspondente.
  comando       text not null check (comando in ('nomus-processos', 'nomus-pessoas', 'tika-ocr')),
  -- Ciclo de vida do comando na fila.
  status        text not null default 'pendente'
                  check (status in ('pendente', 'executando', 'concluido', 'erro')),
  -- Quem disparou (email da sessao do cockpit); null quando origem nao-humana.
  solicitado_por text,
  solicitado_em  timestamptz not null default now(),
  -- Carimbos do PC: quando pegou e quando terminou.
  iniciado_em    timestamptz,
  terminado_em   timestamptz,
  -- Resumo curto do resultado (exit code + cauda do log) gravado pelo PC.
  resultado      text
);

comment on table public.comando_local is
  'Fila de comandos que o cockpit enfileira e o PC local (servico de poll) executa: coleta Nomus e extracao Tika/OCR migradas para o PC pos-Actions. pendente->executando->concluido|erro. RLS sem policy (service-role only via Edges comando-local-enfileirar e comando-local-fila).';

-- Lookup principal: o PC pega o pendente mais antigo; o cockpit lista por recencia.
create index if not exists comando_local_status_idx
  on public.comando_local (status, solicitado_em);

-- =====================================================================
-- comando_local_pegar — pega ATOMICAMENTE o comando pendente mais antigo e o
-- marca 'executando'. FOR UPDATE SKIP LOCKED garante que dois polls
-- concorrentes nunca peguem a mesma linha. Retorna 0 linhas quando a fila
-- esta vazia. service_role (Edge comando-local-fila).
-- =====================================================================
create or replace function public.comando_local_pegar()
returns public.comando_local
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.comando_local;
begin
  select * into v_row
    from public.comando_local
   where status = 'pendente'
   order by solicitado_em asc
   for update skip locked
   limit 1;

  if not found then
    return null;
  end if;

  update public.comando_local
     set status = 'executando',
         iniciado_em = now()
   where id = v_row.id
   returning * into v_row;

  return v_row;
end;
$$;

comment on function public.comando_local_pegar() is
  'Pega atomicamente (FOR UPDATE SKIP LOCKED) o comando_local pendente mais antigo e o marca executando. Usado pelo servico de poll do PC via Edge comando-local-fila. Retorna null quando a fila esta vazia.';

alter table public.comando_local enable row level security;
