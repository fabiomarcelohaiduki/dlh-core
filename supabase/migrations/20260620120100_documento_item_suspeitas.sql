-- =====================================================================
-- Fila de revisao de EXTRACAO de itens (suspeitas de fidelidade / recall).
--
-- POR QUE EXISTE (plano docs/PLANO_EXTRACAO_ITENS_FIDELIDADE.md, decisao 6):
--   A triagem de MATCH (item x produto) ja tem fila propria
--   (triagem_match_feedback). Falta a fila de EXTRACAO: quando o servidor
--   suspeita do que a Lia extraiu, o item e gravado MARCADO (recall total —
--   nunca dropado) e cai aqui para revisao humana. Padrao SOM: nasce
--   'pendente'; nao age sozinha.
--
-- DOIS TIPOS, DUAS CHAVES (assimetria proposital — B1 do relatorio):
--   'fidelidade'    -> a trava per-DOCUMENTO (v1-documento-itens-gravar) achou
--                      um numero que nao bate com o texto-fonte / soma divergente.
--                      A Edge so conhece o documento_id (um documento e
--                      compartilhado por N avisos) -> a suspeita e POR DOCUMENTO
--                      (documento_id obrigatorio, aviso_id null).
--   'recall_effecti'-> a trava per-AVISO (v1-triagem-veredito) achou um item do
--                      piso Effecti (payload_bruto->itensEdital) que nao aparece
--                      em NENHUM documento do aviso -> a suspeita e POR AVISO
--                      (aviso_id obrigatorio).
--   O CHECK documento_item_suspeitas_chave_chk amarra cada tipo a sua chave.
--   (Nota: o plano S1.1 esbocou aviso_id NOT NULL, mas isso e inviavel para
--    'fidelidade' — a Edge per-documento nao tem aviso; aviso_id e nullable e a
--    chave correta de cada tipo e garantida pelo CHECK.)
--
-- SOBREVIVE A RE-EXTRACAO: documento_itens e delete-then-insert (os itens
--   ganham novos uuids a cada run). Por isso documento_item_id e ON DELETE SET
--   NULL e a reconciliacao se da pelo SNAPSHOT (item_descricao / numero_suspeito)
--   + documento_id/aviso_id. As Edges reconciliam apagando apenas as linhas
--   'pendente' do mesmo escopo antes de reinserir (curadas sobrevivem).
--
-- Idempotente (if not exists). Aplicar via node pg direto (SUPABASE_DB_URL
-- session pooler), NUNCA supabase db push.
-- =====================================================================

create table if not exists public.documento_item_suspeitas (
  id                uuid primary key default gen_random_uuid(),
  -- recall_effecti: o buraco e do AVISO (itensEdital e por aviso). fidelidade:
  -- null (a suspeita e do documento, compartilhado por N avisos).
  aviso_id          uuid references public.avisos(id) on delete cascade,
  -- fidelidade: documento de origem do item suspeito. Chave de reconciliacao
  -- (sobrevive ao delete-then-insert dos itens). recall_effecti: pode ser null.
  documento_id      uuid references public.documentos(id) on delete cascade,
  -- Link best-effort ao item; ON DELETE SET NULL (a re-extracao recria os ids).
  -- O snapshot abaixo e a fonte de verdade resiliente.
  documento_item_id uuid references public.documento_itens(id) on delete set null,
  tipo              text not null check (tipo in ('fidelidade', 'recall_effecti')),
  -- Snapshot da descricao do item (exibir a fila / reconciliar sem join).
  item_descricao    text,
  -- O numero que nao bateu (fidelidade) ou o numero do item do piso (recall).
  numero_suspeito   text,
  -- POR QUE e suspeito (motivo legivel). Obrigatorio.
  motivo            text not null,
  -- Fila de curadoria: nasce pendente; o humano confirma/corrige/descarta.
  status            text not null default 'pendente'
                    check (status in ('pendente', 'confirmado', 'corrigido', 'descartado')),
  -- Quem curou (usuario logado do cockpit; multiusuario). null enquanto pendente.
  autor             text,
  created_at        timestamptz not null default now(),
  curado_em         timestamptz,
  -- Coerencia tipo x chave (B1): recall e por aviso; fidelidade e por documento.
  constraint documento_item_suspeitas_chave_chk check (
    (tipo = 'recall_effecti' and aviso_id is not null) or
    (tipo = 'fidelidade'     and documento_id is not null)
  )
);

comment on table public.documento_item_suspeitas is
  'Fila de revisao de EXTRACAO de itens (padrao SOM). fidelidade: numero nao bate com o texto-fonte / soma divergente (POR DOCUMENTO). recall_effecti: item do piso Effecti ausente da extracao do aviso (POR AVISO). Nasce pendente; sobrevive a re-extracao via snapshot. service_role escreve via Edge; sem policies anon/auth.';

-- Fila de curadoria: pendentes primeiro, mais recentes no topo.
create index if not exists documento_item_suspeitas_status_idx
  on public.documento_item_suspeitas (status, created_at desc);

-- Lookup por aviso (recall_effecti) e por documento (fidelidade).
create index if not exists documento_item_suspeitas_aviso_idx
  on public.documento_item_suspeitas (aviso_id);
create index if not exists documento_item_suspeitas_documento_idx
  on public.documento_item_suspeitas (documento_id);

-- Acesso: artefato de NEGOCIO (sem segredo). RLS habilitada; service_role
-- (Edge de leitura/escrita) bypassa. Sem policies para anon/authenticated —
-- espelha triagem_item_matches / triagem_match_feedback / documento_itens
-- (a fila e roteada por Edge/cockpit, nunca por PostgREST direto do navegador).
alter table public.documento_item_suspeitas enable row level security;
