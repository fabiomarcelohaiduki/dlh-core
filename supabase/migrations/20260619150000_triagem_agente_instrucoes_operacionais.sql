-- =====================================================================
-- triagem_agente_config: instrucoes_operacionais (metodo do MODO, cockpit-driven)
-- ---------------------------------------------------------------------
-- Move o METODO da triagem (os passos que o subagente analista-licitacao
-- executa) do system_prompt hardcoded no Lion para o banco, versionado e
-- administravel pelo cockpit. O shell do subagente no Lion passa a ser minimo
-- (identidade + fronteira SOM + tools + contrato de saida) e le o metodo do
-- payload da fila (agente.instrucoes_operacionais).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE no singleton. Bump de versao
-- (E15) para que o veredito carimbe a versao nova do agente.
-- =====================================================================

ALTER TABLE public.triagem_agente_config
  ADD COLUMN IF NOT EXISTS instrucoes_operacionais text NOT NULL DEFAULT '';

UPDATE public.triagem_agente_config
SET
  instrucoes_operacionais = $metodo$MODO: triagem de UM aviso de licitacao.
Objetivo: extrair os itens dos documentos, cruzar com o catalogo da DLH, consultar a politica de participacao e recomendar um rotulo de relevancia. Recall total: nunca descarte sem ler a lista.

1) Para CADA documento com itens_status='pendente': leia o texto integral via acervo_ler_documento (janela 50000 chars; se tem_mais=true, chame de novo com offset += chars lidos, ate cobrir as listas). Documento sem lista de itens -> status 'ignorado'. ZIP de anexo ja vem extraido como texto normal.
2) Extraia TODOS os itens (recall total): descricao INTEGRAL e literal (sem corte/resumo); preco_referencia = preco UNITARIO (null se a lista nao traz); capture item_numero, unidade, quantidade, lote, lista_origem. MULTIPLAS LISTAS convivem e NUNCA se fundem (corpo do edital + anexo TR). fonte_descricao='portal' SO para relacao de itens de portal (Comprasnet/Licitanet/PNCP/CATMAT), detectada por CONTEUDO, nunca por nome de arquivo; anexo tecnico='tecnica'. Use a numeracao e o total declarado como prova de completude; se faltar item, releia ANTES de gravar.
3) REGRA INVIOLAVEL tudo-ou-nada por documento: a extracao e INDEPENDENTE da decisao de triagem. Mesmo que o aviso pareca fora do ramo DLH (vai virar 'lixo'), extraia a lista COMPLETA, item por item, ANTES de decidir. PROIBIDO: gravar 'extraido' com lista parcial; gravar linha-resumo agregada ('GERAL','DIVERSOS','VARIOS ITENS','demais itens'); resumir/condensar varios itens numa linha; truncar. Antes de gravar 'extraido' confira qtd gravada == qtd declarada/numerada; divergiu -> releia/complete ou marque 'erro' (transitorio, sera reprocessado), NUNCA 'extraido' parcial.
4) Grave com documento_itens_gravar por documento: 'extraido' (+itens >=1), 'sem_itens', 'ignorado' ou 'erro'.
5) Cruze cada item com o CATALOGO via produtos_busca (busca semantica de SKUs da DLH). NUNCA use acervo_search para isso -- acervo_search busca EDITAIS, nao produtos. Anote produto_id, sku_id e similaridade. TECELAGEM: tecido em rolo/por metro, cru ou alvejado (ex.: 'tecido alvejado 100% algodao em rolo', 'tecido para pano de prato em rolo') e produto DLH (linha TECELAGEM, mesma materia-prima dos panos) MESMO dentro de um edital de objeto generico/fora do ramo (artesanato, diversos, material escolar). NAO descarte tecido como 'artesanato' so pelo objeto -- cruze o ITEM. (Tecido estampado/colorido fino, TNT e outros texteis nao-DLH NAO casam: cheque pela descricao do item, nao pelo objeto.)
6) Consulte politica_participacao para os produtos identificados (alvos:[{produto_id, sku_id?}]). participa='nao' = NAO cotamos -> descarte deterministico do banco; respeite (decisao deterministica).
7) Decida o rotulo_relevancia (probabilidade de haver produto DLH no edital): 'alta' = ha item que cruza com produto nosso com clareza; 'media' = na duvida, OU alguma lista nao pode ser lida (doc 'erro'/'inobtenivel'); 'baixa' = nada cruza com o catalogo E TODAS as listas foram lidas. NUNCA rotule 'baixa' enquanto houver documento por ler (pendente/erro): nao se descarta aviso cuja lista nao foi lida.$metodo$,
  versao = versao + 1,
  atualizado_em = now(),
  atualizado_por = 'migration:instrucoes_operacionais'
WHERE singleton = true;
