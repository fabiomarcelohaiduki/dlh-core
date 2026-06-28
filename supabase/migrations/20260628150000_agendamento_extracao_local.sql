-- =====================================================================
-- Migration: agendamento da EXTRACAO (Tika/OCR) passa a ser dono do COCKPIT,
-- via fila comando_local — pos-saida do GitHub Actions.
--
-- MOTIVO (28/06): a extracao Tika/OCR migrou para o PC local (mesma decisao do
-- Nomus, ver 20260628140000). No PC, o wrapper extrair-tika.ps1 sobe o Tika
-- server e roda a extracao RAPIDA seguida do passo OCR NA MESMA execucao — um
-- unico comando 'tika-ocr' cobre as duas camadas. Logo o cockpit passa a ter
-- UM relogio de extracao (nao dois): o agendamento da extracao enfileira
-- 'tika-ocr' e o servico de poll do PC executa; o agendamento de OCR separado
-- (job 'extrair-ocr') deixa de existir (o OCR roda junto da extracao no PC).
--
-- O QUE MUDA:
--   1. aplicar_agendamento_extracao(): deixa de chamar a GitHub REST API
--      (extrair-anexos.yml) e passa a enfileirar 'tika-ocr' na fila
--      comando_local (idempotente, via enfileirar_comando_local de
--      20260628140000). Toda a traducao de horario local->UTC e montagem do
--      cron e reproduzida fielmente da versao 09/06.
--   2. aplicar_agendamento_ocr(): vira no-op que apenas APOSENTA o job
--      'extrair-ocr' (o OCR roda junto da extracao no PC). As colunas ocr_* do
--      singleton config_extracao seguem existindo (parametros do OCR: idioma,
--      estrategia), so o RELOGIO separado some.
--   3. Re-aplica os dois para reescrever o estado atual: extracao passa a
--      enfileirar (se ligada) e o job 'extrair-ocr' e removido.
--
-- Idempotente (create or replace). Aplicar via Node `pg` (SUPABASE_DB_URL),
-- padrao do projeto (schema_migrations remoto atrasado).
-- =====================================================================

-- ---------------------------------------------------------------------
-- aplicar_agendamento_extracao(): o job 'extrair-anexos' agora enfileira o
-- comando 'tika-ocr' na fila comando_local (PC local executa extracao rapida +
-- OCR juntos). O resto da funcao (parse de horario local->UTC, montagem do cron)
-- e reproduzido fielmente da versao 09/06.
-- ---------------------------------------------------------------------
create or replace function public.aplicar_agendamento_extracao()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cfg          public.config_extracao%rowtype;
  v_job        text := 'extrair-anexos';
  v_min        int := 0;
  v_local_h    int := 0;
  v_utc_h      int;
  v_day_shift  int;
  v_dow        int;
  v_expr       text;
  v_body       text;
begin
  -- Singleton: 1 linha.
  select * into cfg from public.config_extracao limit 1;

  -- Sempre limpa o job atual antes de (re)agendar (idempotente).
  begin perform cron.unschedule(v_job); exception when others then null; end;

  -- Desligado ou manual => nao agenda nada.
  if cfg.id is null or cfg.agendamento_ativo is not true or cfg.frequencia = 'manual' then
    return 'agendamento extracao desligado';
  end if;

  -- Parse de 'HH:MM' (default 23:00 quando ausente/invalido).
  if cfg.horario_referencia ~ '^\d{1,2}:\d{2}$' then
    v_local_h := split_part(cfg.horario_referencia, ':', 1)::int;
    v_min     := split_part(cfg.horario_referencia, ':', 2)::int;
  else
    v_local_h := 23; v_min := 0;
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

  -- Alvo: fila comando_local. O cron enfileira 'tika-ocr' (idempotente); o
  -- servico de poll do PC pega e roda extrair-tika.ps1 (extracao rapida + OCR).
  v_body := $job$ select public.enfileirar_comando_local('tika-ocr'); $job$;

  perform cron.schedule(v_job, v_expr, v_body);
  return format('agendado extracao: %s (UTC) freq=%s (fila tika-ocr)', v_expr, cfg.frequencia);
end;
$$;

comment on function public.aplicar_agendamento_extracao() is
  'Reescreve o job pg_cron extrair-anexos a partir do singleton config_extracao (horario local UTC-3 -> UTC). Enfileira o comando tika-ocr na fila comando_local (PC local roda extrair-tika.ps1: extracao rapida + OCR juntos). Chamada pelo painel ao salvar o agendamento da extracao.';

-- ---------------------------------------------------------------------
-- aplicar_agendamento_ocr(): no PC o OCR roda JUNTO da extracao (comando unico
-- tika-ocr), entao NAO ha mais relogio de OCR separado. A funcao vira no-op que
-- apenas aposenta o job 'extrair-ocr' (idempotente). Mantida (assinatura) para
-- nao quebrar a Edge ocr-agendamento; sempre retorna desligado.
-- ---------------------------------------------------------------------
create or replace function public.aplicar_agendamento_ocr()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  -- O OCR roda junto da extracao no PC (comando tika-ocr); nenhum job proprio.
  begin perform cron.unschedule('extrair-ocr'); exception when others then null; end;
  return 'agendamento ocr aposentado (OCR roda junto da extracao no PC local)';
end;
$$;

comment on function public.aplicar_agendamento_ocr() is
  'No-op pos-migracao local: o OCR roda junto da extracao no PC (comando tika-ocr de extrair-tika.ps1), entao nao ha job pg_cron extrair-ocr separado. Apenas aposenta o job caso exista. As colunas ocr_* (idioma/estrategia) seguem como parametros do OCR.';

-- Reescreve o estado atual: extracao passa a enfileirar (se ligada); job de OCR
-- separado e removido.
select public.aplicar_agendamento_extracao();
select public.aplicar_agendamento_ocr();
