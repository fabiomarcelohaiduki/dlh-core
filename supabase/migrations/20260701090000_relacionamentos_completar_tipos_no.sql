-- =====================================================================
-- Feature: Relacionamentos
-- Completa os tipos internos que ficaram fora do primeiro seed aplicado.
--
-- Contexto: a migration 20260630030000 hoje declara 10 tipos, mas um banco
-- que já aplicou uma versão anterior do mesmo timestamp pode ter apenas 7
-- (aviso, processo, documento, pessoa, produto, linha, sku). Como migrations
-- aplicadas não rodam de novo, esta correção é aditiva e idempotente.
-- =====================================================================

insert into public.config_tipos_no
  (org_id, tipo, label, icone, cor, ordem, ativo)
select
  o.id,
  v.tipo,
  v.label,
  v.icone,
  v.cor,
  v.ordem,
  true
from public.org o
cross join (
  values
    ('preco', 'Preço', 'badge-dollar-sign', '#22d3ee', 8),
    ('politica', 'Política', 'shield-check', '#84cc16', 9),
    ('cotacao_diretriz', 'Diretriz', 'scroll-text', '#f97316', 10)
) as v (tipo, label, icone, cor, ordem)
on conflict (org_id, tipo) do nothing;
