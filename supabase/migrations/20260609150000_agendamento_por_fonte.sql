-- =====================================================================
-- Migration: Agendamento POR FONTE (substitui o ciclo GLOBAL)
--
-- Decisao (09/06): cada fonte passa a ter seu proprio agendamento, em vez de
-- um relogio global unico que serializa todas as coletas. Comeca pelo Effecti.
-- Cada fonte ganha um job pg_cron proprio ('coleta-<tipo>') que chama o
-- orquestrador escopado com body {"fonte":"<tipo>"}. O ciclo global
-- ('coleta-ciclo') e aposentado: como so dirigia o Effecti na pratica
-- (Nomus/Drive/Gmail rodam no GitHub Actions), nada mais depende dele.
--
-- O agendamento por fonte mora na propria config_ingestao (ja e por fonte):
--   - frequencia / horario_referencia: ja existiam (legado inerte) e voltam a
--     comandar a coleta, agora por fonte.
--   - agendamento_ativo / dia_semana / dia_mes: novos, espelham o que o ciclo
--     global tinha em config_agendamento.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Colunas de agendamento por fonte em config_ingestao.
-- agendamento_ativo liga/desliga a coleta automatica DESTA fonte.
-- dia_semana (0-6) so vale em 'semanal'; dia_mes (1-28) so em 'mensal'.
-- ---------------------------------------------------------------------
alter table public.config_ingestao
  add column if not exists agendamento_ativo boolean not null default false;

alter table public.config_ingestao
  add column if not exists dia_semana int;

alter table public.config_ingestao
  add column if not exists dia_mes int;

-- ---------------------------------------------------------------------
-- aplicar_agendamento_fonte(p_fonte_tipo) — (re)escreve o job pg_cron
-- 'coleta-<tipo>' a partir da config_ingestao da fonte. SECURITY DEFINER:
-- o painel (usuario autorizado) chama via RPC; o agendamento roda com
-- privilegio do owner. Traducao de horario local (UTC-3) -> UTC identica a
-- aplicar_agendamento() global, mas o corpo do job manda {"fonte":"<tipo>"}
-- para o orquestrador rodar SO esta fonte.
-- ---------------------------------------------------------------------
create or replace function public.aplicar_agendamento_fonte(p_fonte_tipo text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_fonte_id     uuid;
  cfg            public.config_ingestao%rowtype;
  v_job          text := 'coleta-' || p_fonte_tipo;
  v_min          int := 0;
  v_local_h      int := 0;
  v_utc_h        int;
  v_day_shift    int;
  v_dow          int;
  v_expr         text;
  v_url          text := 'https://qvggrrirsjidtqsdvmxf.supabase.co/functions/v1/ingestao-orquestrar';
  v_secret       text;
  v_body         text;
begin
  -- Resolve a fonte pelo tipo e carrega a config de ingestao dela.
  select id into v_fonte_id from public.fontes where tipo = p_fonte_tipo limit 1;
  if v_fonte_id is null then
    return format('fonte desconhecida: %s', p_fonte_tipo);
  end if;
  select * into cfg from public.config_ingestao where fonte_id = v_fonte_id limit 1;

  -- Sempre limpa o job atual antes de (re)agendar (idempotente).
  begin perform cron.unschedule(v_job); exception when others then null; end;

  -- Desligado ou manual => nao agenda nada.
  if cfg.id is null or cfg.agendamento_ativo is not true or cfg.frequencia = 'manual' then
    return format('agendamento %s desligado', p_fonte_tipo);
  end if;

  -- Parse de 'HH:MM' (default 07:00 quando ausente/invalido).
  if cfg.horario_referencia ~ '^\d{1,2}:\d{2}$' then
    v_local_h := split_part(cfg.horario_referencia, ':', 1)::int;
    v_min     := split_part(cfg.horario_referencia, ':', 2)::int;
  else
    v_local_h := 7; v_min := 0;
  end if;

  -- Local (UTC-3) -> UTC.
  v_utc_h     := (v_local_h + 3);
  v_day_shift := v_utc_h / 24;       -- 0 ou 1
  v_utc_h     := v_utc_h % 24;

  if cfg.frequencia = 'horaria' then
    v_expr := format('%s * * * *', v_min);
  elsif cfg.frequencia = 'diaria' then
    v_expr := format('%s %s * * *', v_min, v_utc_h);
  elsif cfg.frequencia = 'semanal' then
    v_dow  := (coalesce(cfg.dia_semana, 1) + v_day_shift) % 7;   -- ajuste de dia por UTC
    v_expr := format('%s %s * * %s', v_min, v_utc_h, v_dow);
  elsif cfg.frequencia = 'mensal' then
    v_expr := format('%s %s %s * *', v_min, v_utc_h, coalesce(cfg.dia_mes, 1));
  else
    return 'frequencia desconhecida: ' || cfg.frequencia;
  end if;

  -- Segredo de sistema do Vault (autentica a chamada na Edge Function).
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_DISPATCH_SECRET' limit 1;
  if v_secret is null then
    return 'erro: segredo CRON_DISPATCH_SECRET ausente no Vault';
  end if;

  -- Corpo do job: alem do segredo, manda a fonte para o orquestrador escopar.
  v_body := format(
    $job$
    select net.http_post(
      url     := %L,
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'X-Cron-Secret', %L
                 ),
      body    := jsonb_build_object('fonte', %L)
    );
    $job$, v_url, v_secret, p_fonte_tipo);

  perform cron.schedule(v_job, v_expr, v_body);
  return format('agendado %s: %s (UTC) freq=%s', p_fonte_tipo, v_expr, cfg.frequencia);
end;
$$;

comment on function public.aplicar_agendamento_fonte(text) is
  'Reescreve o job pg_cron coleta-<tipo> a partir da config_ingestao da fonte (horario local UTC-3 -> UTC). Chamada pelo painel ao salvar o agendamento da fonte.';

-- Acesso a RPC: somente service_role (a Edge agendamento-fonte-config invoca
-- server-side). Bloqueia chamada direta por anon/authenticated.
revoke all on function public.aplicar_agendamento_fonte(text) from public, anon, authenticated;
grant execute on function public.aplicar_agendamento_fonte(text) to service_role;

-- ---------------------------------------------------------------------
-- Aposenta o ciclo GLOBAL: remove o job 'coleta-ciclo'. A config_agendamento
-- e a funcao aplicar_agendamento() ficam no banco (sem uso) para nao apagar
-- dado de forma irreversivel; o painel global deixa de exibi-las.
-- ---------------------------------------------------------------------
do $$
begin
  perform cron.unschedule('coleta-ciclo');
exception when others then null;
end;
$$;

-- Aplica o estado inicial das fontes ja cadastradas (todas iniciam com
-- agendamento desligado => nenhum job criado ate o Fabio ligar pelo painel).
select public.aplicar_agendamento_fonte(tipo) from public.fontes;
