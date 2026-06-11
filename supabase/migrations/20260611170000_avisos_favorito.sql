-- Espelho do estado do aviso na plataforma Effecti, lido do payload da
-- listagem (favorito = marcado de interesse; naLixeira = descartado).
-- So LEITURA por ora; o fluxo bidirecional IA<->humano fica para o futuro.
-- Legados ficam NULL ate a proxima recoleta tocar o aviso (sem backfill).
alter table public.avisos add column if not exists favorito boolean;
alter table public.avisos add column if not exists na_lixeira boolean;
