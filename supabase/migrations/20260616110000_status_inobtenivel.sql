-- =====================================================================
-- Status terminal 'inobtenivel' para documento_vinculos.
--
-- MOTIVACAO (decisao Fabio 2026-06-16): nem toda falha de extracao e bug
-- nosso. Quando a FONTE removeu o arquivo (mensagem Gmail deletada, anexo
-- "Arquivo excluido" no PNCP/Effecti, anexo sumido do processo Nomus) ou o
-- conteudo e permanentemente nao-processavel (0 bytes, excede o limite, Tika
-- responde 4xx), reprocessar nunca muda o resultado. Marcar como 'erro'
-- polui a contagem e o item volta a ser reprocessado em vao.
--
-- 'inobtenivel' e um estado TERMINAL distinto de 'erro' (transitorio,
-- reprocessavel): sai da fila, nao conta como erro e o runner o atribui
-- direto quando detecta o sinal terminal (ver extrair-anexos.mjs / Edge
-- documentos-ingerir). Preserva o vinculo (sabemos que o aviso TINHA esse
-- anexo, agora indisponivel) em vez de apagar a linha.
-- =====================================================================

alter table public.documento_vinculos
  drop constraint if exists documento_vinculos_status_extracao_check;

alter table public.documento_vinculos
  add constraint documento_vinculos_status_extracao_check
  check (status_extracao = any (array[
    'pendente'::text,
    'extraido'::text,
    'herdado'::text,
    'erro'::text,
    'precisa_ocr'::text,
    'inobtenivel'::text
  ]));

-- Converte os erros TERMINAIS existentes (fonte removeu / nao-processavel) de
-- 'erro' para 'inobtenivel'. Casa SO os sinais deterministicos terminais; os
-- transitorios (rede, tika_net, 5xx, timeout) seguem em 'erro' p/ reprocessar.
-- Idempotente: so toca quem ainda esta em 'erro' com um sinal terminal.
update public.documento_vinculos
set status_extracao = 'inobtenivel', updated_at = now()
where status_extracao = 'erro'
  and (
    -- Gmail: mensagem deletada/indisponivel na caixa (404).
    erro ~ 'Gmail GET .* falhou \(404\)'
    -- Effecti/PNCP: download 4xx (ex.: 422 "Arquivo excluido" no PNCP).
    or erro ~ 'download Effecti falhou \(4[0-9][0-9]\)'
    -- Nomus: anexo sumiu do processo (nao consta mais no GET individual).
    or erro ~ 'nao encontrado no processo [0-9]+'
    -- Limites deterministicos: vazio (0 bytes) e excede o tamanho maximo.
    or erro like '%[vazio]%'
    or erro like '%[muito_grande]%'
    -- Tika respondeu 4xx: conteudo nao-processavel (corrompido/cifrado/formato).
    or erro ~ '\[tika_http\] Tika respondeu 4[0-9][0-9]'
  );
