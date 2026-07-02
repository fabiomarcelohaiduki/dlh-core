-- =====================================================================
-- Feature: Relacionamentos (Documento feature-relacionamentos.md / SPEC secao 2.5)
-- Migration parte 1/3: SEED INICIAL da feature Relacionamentos.
--
-- Insere de forma IDEMPOTENTE para cada org em public.org:
--   (a) 5 regras macro humanas em catalogo_regras_vinculo (todas ativa=false),
--       conforme tabela 2.5.2 da SPEC. A regra #5 (aviso+numero_pregao+uasg)
--       e COMPOSTA com sequencia ['numero_pregao','uasg']; as 4 primeiras
--       sao SIMPLES.
--   (b) 10 tipos de no por org em config_tipos_no, com labels, icones
--       Lucide e cores da PALETA CANONICA OFICIAL (E8) da SPEC 2.5.1
--       (amber #e27300 marca; demais conforme tabela). Token DLH4
--       (RNF-13) preservado - amber #e27300 para aviso.
--   (c) 1 linha de config_relacionamentos por org com defaults da SPEC
--       2.1.4 (uso_minimo_promocao_alternativa=10, dois_caminhos_minimo=5,
--       uso_minimo_promocao=5, cap_vizinhanca=5, profundidade_max_lia=5,
--       profundidade_default_panorama=2; cap_panorama NULL ate UI definir).
--
-- Idempotencia:
--   regras      -> ON CONFLICT (org_id, origem_tipo, campo_origem,
--                    destino_tipo, campo_destino) DO NOTHING
--   tipos       -> ON CONFLICT (org_id, tipo) DO NOTHING
--   config      -> ON CONFLICT (org_id) DO NOTHING
--
-- UNIQUE constraints de destino ja existem em
-- 20260630020000_relacionamentos_tabelas.sql (esta migration depende
-- daquela aplicada antes).
--
-- Aplica-se UMA UNICA VEZ para cada org existente no momento da migration
-- e re-aplicacoes nao duplicam dados (novas regras entram via insert direto
-- na edge ou via migration posterior).
--
-- Tipos da Fase 5 (proposta, pedido, ata) NAO entram no seed.
-- Regra #6 (pedido<->nota) NAO entra no seed (Fase 5).
-- =====================================================================

-- ---------------------------------------------------------------------
-- (a) 5 REGRAS MACRO HUMANAS (todas ativa=false) - POR ORG.
--
-- O seed itera sobre TODAS as orgs existentes na tabela public.org
-- via INSERT ... SELECT FROM public.org, garantindo 1 linha por org
-- por regra sem duplicar em re-aplicacoes (ON CONFLICT DO NOTHING).
-- ---------------------------------------------------------------------
insert into public.catalogo_regras_vinculo
  (org_id, nome, origem_tipo, campo_origem, destino_tipo, campo_destino,
   combinacao, sequencia, ativa)
select
  o.id,
  v.nome,
  v.origem_tipo,
  v.campo_origem,
  v.destino_tipo,
  v.campo_destino,
  v.combinacao,
  v.sequencia,
  v.ativa
from public.org o
cross join (
  values
    -- #1 aviso<->aviso por uasg (simples). Chave vive no jsonb payload_bruto.
    ('Aviso <-> Aviso por UASG',
     'aviso', 'payload_bruto.uasg', 'aviso', 'payload_bruto.uasg',
     'simples', array['payload_bruto.uasg']::text[], false),
    -- #2 pessoa<->pessoa por cnpj (simples; coluna fisica real).
    ('Pessoa <-> Pessoa por CNPJ',
     'pessoa', 'cnpj', 'pessoa', 'cnpj',
     'simples', array['cnpj']::text[], false),
    -- #3 pessoa<->pessoa por razao social (simples; coluna fisica nome_razao_social).
    ('Pessoa <-> Pessoa por Razao Social',
     'pessoa', 'nome_razao_social', 'pessoa', 'nome_razao_social',
     'simples', array['nome_razao_social']::text[], false),
    -- #4 processo<->processo por serie_m (simples). SEM fonte valida hoje
    --    (nem coluna fisica nem chave jsonb em nomus_processos); fica inerte
    --    (ativa=false) ate o dono definir a chave real.
    ('Processo <-> Processo por Serie M',
     'processo', 'serie_m', 'processo', 'serie_m',
     'simples', array['serie_m']::text[], false),
    -- #5 aviso<->aviso por (numero do pregao, uasg) (composta). Ambas as
    --    chaves vivem no jsonb payload_bruto (o numero do pregao e a chave
    --    `processo`). O pregao sozinho repete entre UASGs -> so composto.
    ('Aviso <-> Aviso por Numero do pregao + UASG',
     'aviso', 'payload_bruto.processo', 'aviso', 'payload_bruto.processo',
     'composta', array['payload_bruto.processo','payload_bruto.uasg']::text[], false)
) as v (nome, origem_tipo, campo_origem, destino_tipo, campo_destino,
        combinacao, sequencia, ativa)
on conflict (org_id, origem_tipo, campo_origem, destino_tipo, campo_destino)
  do nothing;

-- ---------------------------------------------------------------------
-- (b) 10 TIPOS DE NO POR ORG em config_tipos_no.
--
-- Tabela 2.5.1 da SPEC. Paleta canonica oficial (E8). Todos com
-- ativo=true, ordem sequencial (1..7).
-- ---------------------------------------------------------------------
insert into public.config_tipos_no
  (org_id, tipo, label, icone, cor, ordem, ativo)
select
  o.id,
  v.tipo,
  v.label,
  v.icone,
  v.cor,
  v.ordem,
  v.ativo
from public.org o
cross join (
  values
    ('aviso',     'Aviso',     'file-text', '#e27300', 1, true),
    ('processo',  'Processo',  'gavel',     '#f59e0b', 2, true),
    ('documento', 'Documento', 'file',      '#a1a1aa', 3, true),
    ('pessoa',    'Pessoa',    'user',      '#3b82f6', 4, true),
    ('produto',   'Produto',   'package',   '#10b981', 5, true),
    ('linha',     'Linha',     'layers',    '#8b5cf6', 6, true),
    ('sku',       'SKU',       'barcode',   '#ec4899', 7, true),
    ('preco',     'Preço',     'badge-dollar-sign', '#22d3ee', 8, true),
    ('politica',  'Política',  'shield-check',      '#84cc16', 9, true),
    ('cotacao_diretriz', 'Diretriz', 'scroll-text', '#f97316', 10, true)
) as v (tipo, label, icone, cor, ordem, ativo)
on conflict (org_id, tipo) do nothing;

-- ---------------------------------------------------------------------
-- (c) 1 LINHA DE config_relacionamentos POR ORG.
--
-- Defaults da SPEC 2.1.4. cap_panorama fica NULL ate a UI definir
-- (campo opcional sem default canonico).
-- ---------------------------------------------------------------------
insert into public.config_relacionamentos
  (org_id, uso_minimo_promocao_alternativa, dois_caminhos_minimo,
   uso_minimo_promocao, cap_vizinhanca, profundidade_max_lia,
   profundidade_default_panorama)
select
  o.id,
  10,  -- uso_minimo_promocao_alternativa
  5,   -- dois_caminhos_minimo
  5,   -- uso_minimo_promocao
  5,   -- cap_vizinhanca
  5,   -- profundidade_max_lia
  2    -- profundidade_default_panorama
from public.org o
on conflict (org_id) do nothing;
