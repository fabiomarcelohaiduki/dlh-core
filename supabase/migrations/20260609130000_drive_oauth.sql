-- =====================================================================
-- Fonte 'drive' — conexao OAuth pelo cockpit (substitui a colagem manual
-- do refresh_token nos Secrets do Actions).
--
--   ATE AQUI o Drive autenticava com 3 Secrets do Actions (CLIENT_ID,
--   CLIENT_SECRET, REFRESH_TOKEN) colados a mao apos rodar o gerar-token
--   local. Agora o cockpit tem um botao "Conectar Google": o fluxo OAuth
--   (Client Web) volta na Edge drive-oauth, que grava o refresh_token
--   CIFRADO no Vault (set_service_secret 'GOOGLE_DRIVE_REFRESH_TOKEN') e
--   registra QUAL conta esta conectada aqui. O runner deixa de guardar os
--   segredos do Google: pede um access_token fresco a Edge.
--
--   drive_conta  = SINGLETON (id boolean = true). Guarda so o e-mail da
--                  conta conectada + quando — NUNCA o token (vai pro Vault).
--   drive_oauth_state = nonce CSRF de vida curta. Iniciar grava o state +
--                  e-mail de quem iniciou; o callback do Google valida e
--                  consome. O callback NAO carrega a sessao do usuario (vem
--                  do Google), entao o state e a unica amarra de origem.
--
--   DDL idempotente (if not exists). RLS espelha drive_pastas.
-- =====================================================================

-- Conta Drive conectada (singleton). id=true garante linha unica.
create table if not exists public.drive_conta (
  id            boolean primary key default true check (id),
  email         text,                              -- conta Google conectada (null = nunca conectou)
  conectado_em  timestamptz,                       -- quando o ultimo consent foi concluido
  atualizado_em timestamptz not null default now()
);

comment on table public.drive_conta is
  'Singleton: conta Google atualmente conectada ao Drive (e-mail + quando). O refresh_token vive cifrado no Vault, nunca aqui.';

-- Nonce CSRF do fluxo OAuth (curta duracao; o callback consome e apaga).
create table if not exists public.drive_oauth_state (
  state      text primary key,                     -- nonce aleatorio enviado ao Google
  email      text not null,                        -- e-mail autorizado que iniciou o fluxo
  criado_em  timestamptz not null default now()
);

comment on table public.drive_oauth_state is
  'Nonce CSRF do OAuth do Drive: amarra o callback do Google ao usuario que iniciou. Consumido (deletado) no callback; linhas velhas sao limpas por idade.';

-- RLS: policy unica do MVP (usuario autenticado E autorizado). As escritas
-- reais acontecem via service_role nas Edge (bypassa RLS); a policy e defense
-- in depth e habilita a leitura server-side (createClient) do drive_conta.
alter table public.drive_conta enable row level security;
drop policy if exists drive_conta_acesso_autorizado on public.drive_conta;
create policy drive_conta_acesso_autorizado on public.drive_conta
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

alter table public.drive_oauth_state enable row level security;
drop policy if exists drive_oauth_state_acesso_autorizado on public.drive_oauth_state;
create policy drive_oauth_state_acesso_autorizado on public.drive_oauth_state
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());
