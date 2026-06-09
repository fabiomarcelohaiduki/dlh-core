-- =====================================================================
-- Fonte 'gmail' — conexao OAuth pelo cockpit, INDEPENDENTE do Drive
-- (decisao Fabio 2026-06-09: conta separada). Espelha drive_oauth, mas com
-- refresh_token proprio no Vault (GMAIL_REFRESH_TOKEN) e tabelas proprias:
--   - o Gmail pode ser conectado numa conta Google DIFERENTE da do Drive;
--   - trocar a conta de um NAO afeta o outro.
--
--   O cockpit tem um botao "Conectar Google" no card Gmail: o fluxo OAuth
--   (mesmo Client Web do login/Drive, so com callback proprio) volta na Edge
--   gmail-oauth, que grava o refresh_token CIFRADO no Vault e registra QUAL
--   conta esta conectada aqui. O runner (gmail.mjs) deixa de guardar segredos
--   do Google: pede um access_token fresco a Edge (escopo gmail.readonly).
--
--   gmail_conta       = SINGLETON (id boolean = true). So o e-mail conectado
--                       + quando. NUNCA o token (vai pro Vault).
--   gmail_oauth_state = nonce CSRF de vida curta. Iniciar grava o state +
--                       e-mail de quem iniciou; o callback do Google valida e
--                       consome (o callback nao carrega a sessao do usuario).
--
--   DDL idempotente (if not exists). RLS espelha drive_conta/drive_pastas.
-- =====================================================================

-- Conta Gmail conectada (singleton). id=true garante linha unica.
create table if not exists public.gmail_conta (
  id            boolean primary key default true check (id),
  email         text,                              -- conta Google conectada (null = nunca conectou)
  conectado_em  timestamptz,                       -- quando o ultimo consent foi concluido
  atualizado_em timestamptz not null default now()
);

comment on table public.gmail_conta is
  'Singleton: conta Google atualmente conectada ao Gmail (e-mail + quando). Independente do Drive. O refresh_token vive cifrado no Vault, nunca aqui.';

-- Nonce CSRF do fluxo OAuth (curta duracao; o callback consome e apaga).
create table if not exists public.gmail_oauth_state (
  state      text primary key,                     -- nonce aleatorio enviado ao Google
  email      text not null,                        -- e-mail autorizado que iniciou o fluxo
  criado_em  timestamptz not null default now()
);

comment on table public.gmail_oauth_state is
  'Nonce CSRF do OAuth do Gmail: amarra o callback do Google ao usuario que iniciou. Consumido (deletado) no callback; linhas velhas sao limpas por idade.';

-- RLS: policy unica do MVP (usuario autenticado E autorizado). As escritas
-- reais acontecem via service_role nas Edge (bypassa RLS); a policy e defense
-- in depth e habilita a leitura server-side (createClient) do gmail_conta.
alter table public.gmail_conta enable row level security;
drop policy if exists gmail_conta_acesso_autorizado on public.gmail_conta;
create policy gmail_conta_acesso_autorizado on public.gmail_conta
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());

alter table public.gmail_oauth_state enable row level security;
drop policy if exists gmail_oauth_state_acesso_autorizado on public.gmail_oauth_state;
create policy gmail_oauth_state_acesso_autorizado on public.gmail_oauth_state
  for all using (public.is_conta_autorizada())
  with check (public.is_conta_autorizada());
