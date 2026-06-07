-- =====================================================================
-- Sprint: Fontes/credenciais (Vault), config de ingestao e conector Effecti
-- Migration 09/xx: Supabase Vault + RPCs de credencial das fontes
--
-- Objetivo (RNF-02 / US-07): a credencial Effecti vive APENAS no Supabase
-- Vault. fontes.token_cifrado guarda somente a REFERENCIA (id do secret no
-- Vault); o segredo em texto pleno nunca trafega via PostgREST nem volta ao
-- cliente. As Edge Functions manipulam o segredo exclusivamente por estas
-- RPCs SECURITY DEFINER, executaveis somente por service_role (server-side).
--
--   - public.set_fonte_secret(fonte_id, secret): cria/atualiza o secret no
--     Vault e grava a referencia em fontes.token_cifrado. Retorna boolean.
--   - public.get_fonte_secret(fonte_id): le o segredo decifrado em runtime
--     a partir da referencia. Retorna text (ou null se nao configurado).
--
-- O EXECUTE e revogado de public/anon/authenticated e concedido apenas a
-- service_role, garantindo que nenhuma sessao de usuario leia o segredo.
-- =====================================================================

-- Vault ja vem habilitado no Supabase; garantimos de forma idempotente.
create extension if not exists supabase_vault with schema vault;

-- ---------------------------------------------------------------------
-- set_fonte_secret: grava (cria ou atualiza) o segredo da fonte no Vault.
-- SECURITY DEFINER para acessar o schema vault sem expor permissoes ao
-- usuario. Atualiza fontes.token_cifrado com a referencia (uuid do secret),
-- o que tambem dispara os triggers de auditoria e updated_at da tabela.
-- Bloqueia segredo vazio (defense in depth junto a validacao zod na borda).
-- ---------------------------------------------------------------------
create or replace function public.set_fonte_secret(
  p_fonte_id uuid,
  p_secret   text
)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_ref text;
  v_secret_id    uuid;
  v_name         text := concat('fonte_token_', p_fonte_id::text);
  v_description  text := concat('Credencial da fonte ', p_fonte_id::text, ' (RNF-02)');
begin
  if p_secret is null or btrim(p_secret) = '' then
    raise exception 'segredo vazio nao permitido' using errcode = '22023';
  end if;

  select token_cifrado into v_existing_ref
  from public.fontes
  where id = p_fonte_id;

  if not found then
    raise exception 'fonte inexistente: %', p_fonte_id using errcode = 'P0002';
  end if;

  -- Resolve a referencia: primeiro pela ja gravada na fonte, depois pelo nome
  -- deterministico (recuperacao de estado parcial sem duplicar secrets).
  if v_existing_ref is not null then
    begin
      v_secret_id := v_existing_ref::uuid;
    exception when others then
      v_secret_id := null;
    end;
  end if;

  if v_secret_id is null or not exists (select 1 from vault.secrets where id = v_secret_id) then
    select id into v_secret_id from vault.secrets where name = v_name;
  end if;

  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_secret, v_name, v_description);
  else
    v_secret_id := vault.create_secret(p_secret, v_name, v_description);
  end if;

  update public.fontes
  set token_cifrado = v_secret_id::text
  where id = p_fonte_id;

  return true;
end;
$$;

comment on function public.set_fonte_secret(uuid, text) is
  'Grava/atualiza a credencial da fonte no Supabase Vault e guarda a referencia em fontes.token_cifrado (RNF-02). Somente service_role.';

-- ---------------------------------------------------------------------
-- get_fonte_secret: le o segredo decifrado em runtime pela referencia
-- guardada em fontes.token_cifrado. Retorna null quando nao configurado.
-- ---------------------------------------------------------------------
create or replace function public.get_fonte_secret(
  p_fonte_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_ref    text;
  v_secret text;
begin
  select token_cifrado into v_ref
  from public.fontes
  where id = p_fonte_id;

  if v_ref is null or btrim(v_ref) = '' then
    return null;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = v_ref::uuid;

  return v_secret;
exception
  when invalid_text_representation then
    -- referencia corrompida: trata como nao configurado, sem vazar detalhe.
    return null;
end;
$$;

comment on function public.get_fonte_secret(uuid) is
  'Le em runtime o segredo decifrado da fonte a partir da referencia no Vault (RNF-02). Somente service_role.';

-- ---------------------------------------------------------------------
-- Hardening de permissoes: o segredo so pode ser tocado por service_role
-- (uso server-side nas Edge Functions). Nenhuma sessao de usuario executa.
-- ---------------------------------------------------------------------
revoke all on function public.set_fonte_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.get_fonte_secret(uuid) from public, anon, authenticated;

grant execute on function public.set_fonte_secret(uuid, text) to service_role;
grant execute on function public.get_fonte_secret(uuid) to service_role;
