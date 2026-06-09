// =====================================================================
// _shared/env.ts
// Leitura e validacao de variaveis de ambiente no startup (RNF: config via
// env validada). Falha cedo e com mensagem clara quando uma variavel
// obrigatoria esta ausente, evitando comportamento silencioso em runtime.
//
// Em Edge Functions o Supabase injeta SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY automaticamente; aceitamos tambem os nomes
// NEXT_PUBLIC_* (compartilhados com o front) como fallback para dev local.
// =====================================================================

export interface AppEnv {
  /** URL do projeto Supabase. */
  supabaseUrl: string;
  /** Chave anonima (respeita RLS no contexto do usuario autenticado). */
  anonKey: string;
  /** Chave service_role (bypassa RLS — uso restrito server-side). */
  serviceRoleKey: string;
  /** URL de callback do OAuth (opcional; pode vir do request). */
  authRedirectUrl?: string;
  /** Dominio confiavel semente da allowlist (opcional). */
  authorizedEmailDomain?: string;
  /** DSN do Sentry; quando ausente, a observabilidade externa fica desabilitada. */
  sentryDsn?: string;
  /** Provider de embeddings selecionado (default bge-m3 local). */
  embeddingsProvider: string;
  /** Endpoint HTTP do servico de embeddings self-hosted (sem custo por token). */
  embeddingsEndpoint?: string;
  /** Dimensao do embedding (deve casar com vector(1024) do substrato). */
  embeddingsDim: number;
  /** Endpoint HTTP do servico de extracao de texto/OCR de arquivos de edital. */
  fileExtractionEndpoint?: string;
  /** Bucket privado do Storage onde os binarios de edital sao preservados. */
  editaisBucket: string;
  /** API key do provedor de e-mail transacional (Resend/SMTP). */
  emailProviderApiKey?: string;
  /** Remetente dos alertas transacionais. */
  alertEmailFrom?: string;
  /** Destinatarios dos alertas de falha (lista separada por virgula). */
  alertEmailRecipients: string[];
  /** Client ID do OAuth Google (Aplicativo Web) usado na conexao do Drive pelo cockpit. */
  driveOauthClientId?: string;
  /** Client secret do OAuth Google (Aplicativo Web) — troca de code/refresh por access_token. */
  driveOauthClientSecret?: string;
  /** Redirect URI registrada no Google que aponta para o callback da Edge drive-oauth. */
  driveOauthRedirect?: string;
  /** URL do cockpit para onde o callback redireciona o navegador apos conectar (ex.: http://localhost:3000/fontes). */
  driveOauthReturnUrl?: string;
}

/** Embedding default do MVP (bge-m3 local self-hosted, vector(1024)). */
const DEFAULT_EMBEDDINGS_PROVIDER = "bge-m3-local";
const DEFAULT_EMBEDDINGS_DIM = 1024;
const DEFAULT_EDITAIS_BUCKET = "editais";

/** Converte string de env em inteiro positivo; usa o fallback se invalida. */
function parseDim(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Quebra uma lista separada por virgula em itens nao-vazios e normalizados. */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function firstNonEmpty(...names: string[]): string | undefined {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function requireEnv(label: string, ...names: string[]): string {
  const value = firstNonEmpty(...names);
  if (!value) {
    throw new Error(
      `Variavel de ambiente obrigatoria ausente: ${label} (procurada em: ${names.join(", ")})`,
    );
  }
  return value;
}

let cached: AppEnv | null = null;

/**
 * Retorna a configuracao validada. A primeira chamada valida e cacheia.
 * Lanca Error com contexto quando uma variavel obrigatoria esta ausente.
 */
export function getEnv(): AppEnv {
  if (cached) return cached;

  cached = {
    supabaseUrl: requireEnv("Supabase URL", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"),
    anonKey: requireEnv("Supabase anon key", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    serviceRoleKey: requireEnv("Supabase service_role key", "SUPABASE_SERVICE_ROLE_KEY"),
    authRedirectUrl: firstNonEmpty("AUTH_REDIRECT_URL"),
    authorizedEmailDomain: firstNonEmpty("AUTHORIZED_EMAIL_DOMAIN"),
    sentryDsn: firstNonEmpty("SENTRY_DSN"),
    embeddingsProvider: firstNonEmpty("EMBEDDINGS_PROVIDER") ?? DEFAULT_EMBEDDINGS_PROVIDER,
    embeddingsEndpoint: firstNonEmpty("EMBEDDINGS_ENDPOINT"),
    embeddingsDim: parseDim(firstNonEmpty("EMBEDDINGS_DIM"), DEFAULT_EMBEDDINGS_DIM),
    fileExtractionEndpoint: firstNonEmpty("FILE_EXTRACTION_ENDPOINT"),
    editaisBucket: firstNonEmpty("EDITAIS_BUCKET") ?? DEFAULT_EDITAIS_BUCKET,
    emailProviderApiKey: firstNonEmpty("EMAIL_PROVIDER_API_KEY"),
    alertEmailFrom: firstNonEmpty("ALERT_EMAIL_FROM"),
    alertEmailRecipients: parseList(firstNonEmpty("ALERT_EMAIL_RECIPIENTS")),
    driveOauthClientId: firstNonEmpty("GOOGLE_OAUTH_CLIENT_ID_WEB"),
    driveOauthClientSecret: firstNonEmpty("GOOGLE_OAUTH_CLIENT_SECRET_WEB"),
    driveOauthRedirect: firstNonEmpty("GOOGLE_OAUTH_REDIRECT"),
    driveOauthReturnUrl: firstNonEmpty("DRIVE_OAUTH_RETURN_URL"),
  };

  return cached;
}
