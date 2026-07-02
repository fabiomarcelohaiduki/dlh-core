-- =====================================================================
-- Feature: Relacionamentos (GraphLink) - remove a regra "Processo <-> Processo
-- por Serie M" do catalogo.
--
-- Contexto: o seed 20260630030000 cadastrou essa regra apontando para o campo
-- `serie_m`, que NAO existe em nomus_processos (nem coluna fisica nem chave do
-- jsonb payload_bruto - confirmado no substrato em 2026-07-02). A regra ficava
-- inerte (ativa=false) e nunca geraria aresta. Decisao do dono (2026-07-02):
-- REMOVER em vez de manter lixo no catalogo.
--
-- Seguranca: a regra e inerte e nao tem vinculos_inferidos_lia filhos
-- (regra_macro_id -> catalogo_regras_vinculo). `relacoes` sao arestas
-- polimorficas sem FK ao catalogo. DELETE direto e seguro e reversivel
-- (basta re-cadastrar pela UI). Idempotente: re-aplicacao = 0 linhas.
--
-- O seed 20260630030000 ja foi ajustado para NAO recriar essa regra em
-- bancos novos (a partir de agora sao 4 regras macro, nao 5).
-- =====================================================================

delete from public.catalogo_regras_vinculo
where origem_tipo = 'processo'
  and destino_tipo = 'processo'
  and campo_destino = 'serie_m';
