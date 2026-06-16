-- =====================================================================
-- Migration: AUTO-RETRY da EXTRACAO (camada 1, dentro do run manual).
--
--   PROBLEMA: na extracao, uma falha do anexo caia DIRETO num card
--   terminal — `erro` (transitorio) ou `inobtenivel` (irrecuperavel) — sem
--   nenhuma nova tentativa. So o botao manual "Reprocessar erros" reabria.
--   Diferente da indexacao, a extracao NAO tinha contador de tentativas.
--
--   FIX (decisao Fabio): quando o Fabio dispara a extracao manual, cada
--   anexo deve ser tentado ate 3x DENTRO daquele run ANTES de cair no card.
--   Vale para `erro` E para `inobtenivel`. So vira terminal ao atingir o
--   teto; abaixo dele volta 'pendente' e a propria iteracao do orquestrador
--   (while-loop que re-busca a fila) o reprocessa no mesmo run.
--   SEM cron de fundo (controle 100% manual, padrao do extrator).
--   `precisa_ocr` NAO entra no contador (nao e falha; drena no run de OCR).
--
--   FIX (automatico + continuo, sem hardcode):
--     (1) coluna documento_vinculos.tentativas_extracao (conta as falhas).
--     (2) config_extracao.tentativas_max (teto, default 3; administravel).
--     (3) marcar_falha_extracao(id, teto, terminal, erro): no Edge, incrementa
--         tentativas e RE-MARCA 'pendente' enquanto < teto (o run drena
--         pendente sozinho -> reprocesso transparente); so vira o status
--         TERMINAL ('inobtenivel' se terminal=true, senao 'erro') ao atingir
--         o teto. Retorna o status resultante para log do Edge.
--
--   Idempotente: add column if not exists / create or replace. Aplicar via
--   Node `pg` (SUPABASE_DB_URL), padrao do projeto (NUNCA supabase db push).
-- =====================================================================

-- ---------------------------------------------------------------------
-- (1) Contador de tentativas por vinculo de extracao.
-- ---------------------------------------------------------------------
alter table public.documento_vinculos
  add column if not exists tentativas_extracao int not null default 0;

-- ---------------------------------------------------------------------
-- (2) Teto de tentativas administravel (singleton config_extracao).
-- ---------------------------------------------------------------------
alter table public.config_extracao
  add column if not exists tentativas_max int not null default 3;

-- ---------------------------------------------------------------------
-- (3) marcar_falha_extracao — incrementa tentativas e decide o destino.
--     < teto -> volta 'pendente' (reprocesso automatico no proprio run).
--     >= teto -> status TERMINAL: 'inobtenivel' (p_terminal) ou 'erro'.
--     Grava a msg de erro. Retorna o status resultante.
-- ---------------------------------------------------------------------
create or replace function public.marcar_falha_extracao(
  p_id       uuid,
  p_teto     int,
  p_terminal boolean,
  p_erro     text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  update public.documento_vinculos v
  set tentativas_extracao = coalesce(v.tentativas_extracao, 0) + 1,
      erro = p_erro,
      status_extracao = case
        when coalesce(v.tentativas_extracao, 0) + 1 >= greatest(p_teto, 1)
          then case when p_terminal then 'inobtenivel' else 'erro' end
        else 'pendente'
      end
  where v.id = p_id
  returning v.status_extracao into v_status;
  return v_status;
end;
$$;

comment on function public.marcar_falha_extracao(uuid, int, boolean, text) is
  'Registra uma falha de extracao do vinculo: incrementa tentativas_extracao e re-marca pendente enquanto abaixo do teto (auto-retry no mesmo run), ou status terminal (inobtenivel se p_terminal, senao erro) ao atingir o teto. Retorna o status resultante.';

revoke all on function public.marcar_falha_extracao(uuid, int, boolean, text) from public, anon, authenticated;
grant execute on function public.marcar_falha_extracao(uuid, int, boolean, text) to service_role;
