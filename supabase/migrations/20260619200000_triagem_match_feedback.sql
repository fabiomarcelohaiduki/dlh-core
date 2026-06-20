-- =====================================================================
-- Feedback humano de MATCH (item-do-edital x produto/SKU do catalogo).
--
-- POR QUE EXISTE (decisao Fabio 2026-06-19):
--   A triagem da Lia casa cada item do edital com um produto/SKU
--   (triagem_item_matches). O match acerta o PRODUTO mas erra o SKU com
--   frequencia (SKUs irmaos tem embedding quase identico e o edital raramente
--   especifica a variante). Falta um canal para o humano CORRIGIR o match na
--   propria tela (cockpit) e essa correcao virar APRENDIZADO.
--
--   Esta tabela e uma FILA (nao age sozinha, padrao SOM): captura a correcao,
--   nasce 'pendente'. A curadoria (promover para cotacao_regras OU para o metodo
--   do agente) e humana, depois, com aprovacao. Por isso curado_em/curado_destino.
--
-- 3 ACOES (cobrem todos os casos de erro de match):
--   'corrigir'  -> tinha match, produto e/ou SKU errados. produto_correto_id
--                  obrigatorio (sku opcional: pode corrigir so o produto).
--   'remover'   -> tinha match, NAO era para dar (falso positivo). Sem correto.
--   'adicionar' -> item SEM match que deveria ter (falso negativo).
--                  produto_correto_id obrigatorio.
--
-- SNAPSHOT: produto_sugerido_* guarda o que a Lia havia cravado no momento da
--   correcao (resiliente a re-triagem). produto_sugerido_nome para exibir a fila
--   sem join.
--
-- POR QUE POR AVISO+ITEM: simetrico a triagem_item_matches. O item e do
--   documento (dedup global), mas a correcao e daquele aviso. unique
--   (aviso_id, documento_item_id): uma correcao vigente por item por aviso
--   (re-corrigir sobrescreve via upsert no Edge).
--
-- Idempotente (if not exists). Aplicar via node pg direto (SUPABASE_DB_URL
-- session pooler), NUNCA supabase db push.
-- =====================================================================

create table if not exists public.triagem_match_feedback (
  id                  uuid primary key default gen_random_uuid(),
  aviso_id            uuid not null references public.avisos(id) on delete cascade,
  documento_item_id   uuid not null references public.documento_itens(id) on delete cascade,
  -- Snapshot da descricao do item (exibir a fila sem join em documento_itens).
  item_descricao      text,
  -- 'corrigir' | 'remover' | 'adicionar' (derivavel dos campos, guardada
  -- explicita para a fila ficar legivel).
  acao                text not null check (acao in ('corrigir', 'remover', 'adicionar')),
  -- O que a Lia havia cravado (snapshot). null quando acao='adicionar'.
  produto_sugerido_id   uuid references public.produtos(id) on delete set null,
  sku_sugerido_id       uuid references public.produto_skus(id) on delete set null,
  produto_sugerido_nome text,
  -- O match correto segundo o humano. null quando acao='remover'.
  produto_correto_id    uuid references public.produtos(id) on delete set null,
  sku_correto_id        uuid references public.produto_skus(id) on delete set null,
  -- POR QUE o match estava errado (alimenta a regra na curadoria). Obrigatorio.
  motivo              text not null,
  -- Fila de curadoria: nasce pendente; vira promovido/descartado na revisao.
  status              text not null default 'pendente'
                      check (status in ('pendente', 'promovido', 'descartado')),
  -- Quem corrigiu (usuario logado do cockpit; multiusuario).
  autor               text,
  created_at          timestamptz not null default now(),
  -- Curadoria: quando e para onde a correcao foi promovida.
  curado_em           timestamptz,
  curado_destino      text check (curado_destino in ('cotacao_regras', 'metodo')),
  -- Uma correcao vigente por item dentro de um aviso (re-corrigir = upsert).
  constraint triagem_match_feedback_aviso_item_key unique (aviso_id, documento_item_id),
  -- Coerencia acao x campos do correto.
  constraint triagem_match_feedback_acao_chk check (
    (acao = 'remover'   and produto_correto_id is null and sku_correto_id is null) or
    (acao = 'adicionar' and produto_correto_id is not null) or
    (acao = 'corrigir'  and produto_correto_id is not null)
  )
);

comment on table public.triagem_match_feedback is
  'Feedback humano do match item x produto/SKU (fila de aprendizado, padrao SOM). Nasce pendente; a curadoria promove para cotacao_regras ou para o metodo do agente. Por aviso+item (simetrico a triagem_item_matches). produto_sugerido_nome e snapshot.';

-- Fila de curadoria: pendentes primeiro, mais recentes no topo.
create index if not exists triagem_match_feedback_status_idx
  on public.triagem_match_feedback (status, created_at desc);

-- Lookup do cockpit: correcoes de um aviso (painel de itens expandido).
create index if not exists triagem_match_feedback_aviso_idx
  on public.triagem_match_feedback (aviso_id);

-- Acesso: artefato de NEGOCIO (sem segredo). RLS habilitada; service_role
-- (Edge de leitura/escrita) bypassa. A Lia le via SQL read-only amplo. Sem
-- policies para anon/authenticated (acesso server-side).
alter table public.triagem_match_feedback enable row level security;
