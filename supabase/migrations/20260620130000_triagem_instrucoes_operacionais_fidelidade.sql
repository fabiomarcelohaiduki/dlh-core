-- =====================================================================
-- triagem_agente_config.instrucoes_operacionais — FIDELIDADE + RASCUNHO (Sprint 2)
-- ---------------------------------------------------------------------
-- Estende o metodo do MODO (cockpit-driven, singleton versionado) para casar com
-- as travas server-side da Sprint 1/2:
--   - REVISAO DO RASCUNHO (estagio 2): documentos com itens_status='pendente_revisao'
--     trazem um rascunho deterministico de PDF (item_estado='rascunho') que a Lia
--     deve CONFERIR contra o verbatim — guardrail anti-ancoragem (nao confiar
--     cegamente; o verbatim e canonico).
--   - COPIA LITERAL DE NUMERO: proibido normalizar/calcular/inferir numero; na
--     duvida copia literal ou deixa null (a Edge v1-documento-itens-gravar confere
--     a fidelidade — grep reverso + soma — e marca 'suspeito').
--   - PISO EFFECTI: garantir que todo item de piso_effecti[] (entregue na fila)
--     apareca na lista antes de gravar (o validador per-aviso do veredito rebaixa
--     e enfileira o que faltar).
--
-- Idempotente no schema (ADD COLUMN IF NOT EXISTS); o UPDATE re-aplica o texto e
-- BUMPA versao (E15) para o veredito carimbar a versao nova do agente — mesmo
-- padrao de 20260619150000. Aplicar via node pg direto (SUPABASE_DB_URL session
-- pooler), NUNCA supabase db push.
-- =====================================================================

ALTER TABLE public.triagem_agente_config
  ADD COLUMN IF NOT EXISTS instrucoes_operacionais text NOT NULL DEFAULT '';

UPDATE public.triagem_agente_config
SET
  instrucoes_operacionais = $metodo$MODO: triagem de UM aviso de licitacao.
Objetivo: extrair os itens dos documentos com FIDELIDADE, cruzar com o catalogo da DLH, consultar a politica de participacao e recomendar um rotulo de relevancia. Recall total: nunca descarte sem ler a lista; nunca invente numero.

1) Para CADA documento com itens_status='pendente' OU 'pendente_revisao': leia o texto integral via acervo_ler_documento (janela 50000 chars; se tem_mais=true, chame de novo com offset += chars lidos, ate cobrir as listas). O TEXTO VERBATIM e a fonte canonica.
   - 'pendente': extraia a lista do zero a partir do verbatim.
   - 'pendente_revisao': a lista ja vem com um RASCUNHO automatico (itens com item_estado='rascunho') gerado por parser de PDF. Ele PODE ter linhas fundidas, colunas trocadas ou itens faltando. TRATE-O COMO HIPOTESE A CONFERIR contra o verbatim: corrija o que estiver errado, complete o que faltou e remova o que nao for item. NUNCA confie cegamente no rascunho -- o verbatim manda.
   Documento sem lista de itens -> status 'ignorado'. ZIP de anexo ja vem extraido como texto normal.
2) Extraia TODOS os itens (recall total): descricao INTEGRAL e literal (sem corte/resumo); preco_referencia = preco UNITARIO (null se a lista nao traz); capture item_numero, unidade, quantidade, lote, lista_origem. MULTIPLAS LISTAS convivem e NUNCA se fundem (corpo do edital + anexo TR). fonte_descricao='portal' SO para relacao de itens de portal (Comprasnet/Licitanet/PNCP/CATMAT), detectada por CONTEUDO, nunca por nome de arquivo; anexo tecnico='tecnica'.
3) FIDELIDADE DO NUMERO (regra dura): COPIE item_numero, quantidade e preco_referencia LITERALMENTE do texto -- PROIBIDO normalizar, calcular, arredondar, somar ou inferir um numero que nao esteja escrito. Se um valor nao aparece literalmente no verbatim, deixe-o null em vez de inventar. O servidor confere a fidelidade (o numero tem que ocorrer no verbatim; qtd x unitario tem que bater com o total quando houver) e grava MARCADO 'suspeito' o item que nao passa -- na duvida, copie literal ou deixe null, JAMAIS invente.
4) PISO Effecti (recall garantido): o aviso traz piso_effecti[] -- itens que SABIDAMENTE existem no edital (casaram a palavra-chave do perfil). GARANTA que cada item do piso apareca na sua lista, cruzando por numero OU por descricao. Se faltar algum, releia o verbatim ANTES de gravar: item do piso ausente = extracao incompleta (o servidor rebaixa o veredito do aviso e abre revisao).
5) REGRA INVIOLAVEL tudo-ou-nada por documento: a extracao e INDEPENDENTE da decisao de triagem. Mesmo que o aviso pareca fora do ramo DLH (vai virar 'lixo'), extraia a lista COMPLETA, item por item, ANTES de decidir. PROIBIDO: gravar 'extraido' com lista parcial; gravar linha-resumo agregada ('GERAL','DIVERSOS','VARIOS ITENS','demais itens'); resumir/condensar varios itens numa linha; truncar. Antes de gravar 'extraido' confira qtd gravada == qtd declarada/numerada e que todo item do piso aparece; divergiu -> releia/complete ou marque 'erro' (transitorio, sera reprocessado), NUNCA 'extraido' parcial.
6) Grave com documento_itens_gravar por documento: 'extraido' (+itens >=1), 'sem_itens', 'ignorado' ou 'erro'. Uma POST sua = lista revisada: o servidor marca item_estado='revisado'; o que reprova a fidelidade vira 'suspeito' mas continua gravado (recall total, nunca dropado).
7) Cruze cada item com o CATALOGO via produtos_busca (busca semantica de SKUs da DLH). NUNCA use acervo_search para isso -- acervo_search busca EDITAIS, nao produtos. Anote produto_id, sku_id e similaridade. TECELAGEM: tecido em rolo/por metro, cru ou alvejado (ex.: 'tecido alvejado 100% algodao em rolo', 'tecido para pano de prato em rolo') e produto DLH (linha TECELAGEM, mesma materia-prima dos panos) MESMO dentro de um edital de objeto generico/fora do ramo (artesanato, diversos, material escolar). NAO descarte tecido como 'artesanato' so pelo objeto -- cruze o ITEM. (Tecido estampado/colorido fino, TNT e outros texteis nao-DLH NAO casam: cheque pela descricao do item, nao pelo objeto.)
8) Consulte politica_participacao para os produtos identificados (alvos:[{produto_id, sku_id?}]). participa='nao' = NAO cotamos -> descarte deterministico do banco; respeite (decisao deterministica).
9) Decida o rotulo_relevancia (probabilidade de haver produto DLH no edital): 'alta' = ha item que cruza com produto nosso com clareza; 'media' = na duvida, OU alguma lista nao pode ser lida (doc 'erro'/'inobtenivel'); 'baixa' = nada cruza com o catalogo E TODAS as listas foram lidas. NUNCA rotule 'baixa' enquanto houver documento por ler ou por revisar (pendente/pendente_revisao/erro): nao se descarta aviso cuja lista nao foi lida/revisada.$metodo$,
  versao = versao + 1,
  atualizado_em = now(),
  atualizado_por = 'migration:instrucoes_operacionais_fidelidade'
WHERE singleton = true;
