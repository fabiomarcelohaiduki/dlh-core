-- =====================================================================
-- Feature: Relacionamentos
-- Correcao de eficiencia e consistencia das arestas internas.
--
-- Contexto:
--   * relacoes_vizinhanca sempre filtra status='confirmado'. Indices
--     parciais reduzem o conjunto percorrido quando a malha crescer.
--   * Bancos que rodaram uma versao anterior do backfill podem ter gravado
--     arestas internas com destino_tipo='sku' apontando para ids de preco,
--     politica ou diretriz. O codigo atual ja gera os tipos corretos; esta
--     migration corrige o dado legado sem duplicar arestas.
-- =====================================================================

create index if not exists idx_relacoes_confirmadas_origem
  on public.relacoes (origem_tipo, origem_id)
  where status = 'confirmado';

create index if not exists idx_relacoes_confirmadas_destino
  on public.relacoes (destino_tipo, destino_id)
  where status = 'confirmado';

create index if not exists idx_relacoes_chave
  on public.relacoes (chave);

-- ---------------------------------------------------------------------
-- 1) sku -> preco
-- ---------------------------------------------------------------------
delete from public.relacoes bad
using public.relacoes good,
      public.sku_precos_calculados p
where bad.chave = 'fk:sku_precos_calculados:' || p.id::text
  and bad.relacao like 'tem_preco_%'
  and bad.origem_tipo = 'sku'
  and bad.origem_id = p.sku_id::text
  and bad.destino_id = p.id::text
  and bad.destino_tipo <> 'preco'
  and good.origem_tipo = bad.origem_tipo
  and good.origem_id = bad.origem_id
  and good.destino_tipo = 'preco'
  and good.destino_id = bad.destino_id
  and good.relacao = bad.relacao;

update public.relacoes r
set destino_tipo = 'preco',
    updated_at = now(),
    versao = r.versao + 1
from public.sku_precos_calculados p
where r.chave = 'fk:sku_precos_calculados:' || p.id::text
  and r.relacao like 'tem_preco_%'
  and r.origem_tipo = 'sku'
  and r.origem_id = p.sku_id::text
  and r.destino_id = p.id::text
  and r.destino_tipo <> 'preco';

-- ---------------------------------------------------------------------
-- 2) produto -> politica
-- ---------------------------------------------------------------------
delete from public.relacoes bad
using public.relacoes good,
      public.politica_participacao p
where bad.chave = 'fk:politica_participacao:' || p.id::text
  and bad.relacao = 'tem_politica'
  and bad.origem_tipo = 'produto'
  and bad.origem_id = p.escopo_id::text
  and bad.destino_id = p.id::text
  and bad.destino_tipo <> 'politica'
  and good.origem_tipo = bad.origem_tipo
  and good.origem_id = bad.origem_id
  and good.destino_tipo = 'politica'
  and good.destino_id = bad.destino_id
  and good.relacao = bad.relacao;

update public.relacoes r
set destino_tipo = 'politica',
    updated_at = now(),
    versao = r.versao + 1
from public.politica_participacao p
where r.chave = 'fk:politica_participacao:' || p.id::text
  and r.relacao = 'tem_politica'
  and r.origem_tipo = 'produto'
  and r.origem_id = p.escopo_id::text
  and r.destino_id = p.id::text
  and r.destino_tipo <> 'politica';

-- ---------------------------------------------------------------------
-- 3) produto -> cotacao_diretriz
-- ---------------------------------------------------------------------
delete from public.relacoes bad
using public.relacoes good,
      public.cotacao_diretrizes d
where bad.chave = 'fk:cotacao_diretrizes:' || d.id::text
  and bad.relacao = 'tem_diretriz'
  and bad.origem_tipo = 'produto'
  and bad.origem_id = d.escopo_id::text
  and bad.destino_id = d.id::text
  and bad.destino_tipo <> 'cotacao_diretriz'
  and good.origem_tipo = bad.origem_tipo
  and good.origem_id = bad.origem_id
  and good.destino_tipo = 'cotacao_diretriz'
  and good.destino_id = bad.destino_id
  and good.relacao = bad.relacao;

update public.relacoes r
set destino_tipo = 'cotacao_diretriz',
    updated_at = now(),
    versao = r.versao + 1
from public.cotacao_diretrizes d
where r.chave = 'fk:cotacao_diretrizes:' || d.id::text
  and r.relacao = 'tem_diretriz'
  and r.origem_tipo = 'produto'
  and r.origem_id = d.escopo_id::text
  and r.destino_id = d.id::text
  and r.destino_tipo <> 'cotacao_diretriz';
