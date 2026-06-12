-- Write-back de favorito para a Effecti: marca quando o favorito da linha ja
-- foi propagado (PUT /aviso/favoritar-licitacao) para evitar re-disparar a cada
-- coleta. Reseta para false quando o favorito da linha cai para false, de modo
-- que um eventual re-favoritar volte a propagar. Default false (legados nao
-- propagados ainda; sobem na proxima coleta que detectar favorito=true).
alter table public.avisos add column if not exists favorito_propagado boolean not null default false;
