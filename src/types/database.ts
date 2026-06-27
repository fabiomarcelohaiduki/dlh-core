// =====================================================================
// Tipos do schema Supabase da Fase 0 (Cockpit LionClaw).
// Fonte de verdade: supabase/migrations/20260626120000_fase0_org_membership.sql
// e 20260626120100_fase0_tema_configuracao_bloco_config.sql (SPEC 2.1).
//
// Formato compativel com o generico `Database` do @supabase/supabase-js:
//   createBrowserClient<Database>(...) / createServerClient<Database>(...)
// Cada tabela expoe Row (leitura), Insert (escrita) e Update (patch).
// Nomes em snake_case espelhando as colunas reais do Postgres.
// =====================================================================

/** Area inicial do cockpit (configuracao.area_inicial / default_area). */
export type AreaInicial = "cockpit" | "atividade_global" | "configuracao_geral";

/** Densidade visual das tabelas (configuracao.densidade). */
export type Densidade = "compacta" | "padrao" | "confortavel";

/** Tipo de bloco configuravel (bloco_config.tipo). */
export type BlocoTipo = "bloco" | "card" | "widget";

/** Banda/regiao do bloco na tela (bloco_config.banda). */
export type BlocoBanda = "topo" | "status" | "ferramentas" | "acao" | "tabela";

/** Papel do usuario na organizacao (org_membership.papel). */
export type OrgPapel = "member" | "manutencao" | (string & {});

// NOTA: Row/Insert sao `type` aliases (nao `interface`) de proposito. O cliente
// Supabase tipado (SupabaseClient<Database>) exige que cada tabela satisfaca
// `GenericTable` (Row/Insert/Update assignaveis a `Record<string, unknown>`).
// Interfaces NAO sao assignaveis a Record<string, unknown> (sem index signature
// implicita), o que colapsaria o `Schema` para `never` nas escritas. Os type
// aliases abaixo preservam a mesma forma e satisfazem o contrato.
export type OrgRow = {
  id: string;
  nome: string;
  created_at: string;
};
export type OrgInsert = {
  id?: string;
  nome: string;
  created_at?: string;
};
export type OrgUpdate = Partial<OrgInsert>;

export type OrgMembershipRow = {
  user_id: string;
  org_id: string;
  papel: OrgPapel;
  created_at: string;
};
export type OrgMembershipInsert = {
  user_id: string;
  org_id: string;
  papel?: OrgPapel;
  created_at?: string;
};
export type OrgMembershipUpdate = Partial<OrgMembershipInsert>;

export type TemaRow = {
  id: string;
  nome: string;
  acento: string;
  fundo: string;
  texto: string;
  created_at: string;
};
export type TemaInsert = {
  id?: string;
  nome: string;
  acento: string;
  fundo: string;
  texto: string;
  created_at?: string;
};
export type TemaUpdate = Partial<TemaInsert>;

export type ConfiguracaoRow = {
  id: string;
  user_id: string;
  org_id: string;
  area_inicial: AreaInicial | null;
  linhas_compactas: boolean;
  destacar_pendencias: boolean;
  tema_id: string | null;
  densidade: Densidade;
  reduzir_movimento: boolean;
  highlight_pendencias: boolean;
  default_area: AreaInicial | null;
  tz: string;
  date_fmt: string;
  num_fmt: string;
  notify_alerts: boolean;
  notify_ingest: boolean;
  notify_deadline: boolean;
  notify_digest: boolean;
  auto_sync: boolean;
  sync_freq: number;
  session_timeout: number;
  session_warn: boolean;
  created_at: string;
  updated_at: string;
};
export type ConfiguracaoInsert = {
  id?: string;
  user_id: string;
  org_id: string;
  area_inicial?: AreaInicial | null;
  linhas_compactas?: boolean;
  destacar_pendencias?: boolean;
  tema_id?: string | null;
  densidade?: Densidade;
  reduzir_movimento?: boolean;
  highlight_pendencias?: boolean;
  default_area?: AreaInicial | null;
  tz?: string;
  date_fmt?: string;
  num_fmt?: string;
  notify_alerts?: boolean;
  notify_ingest?: boolean;
  notify_deadline?: boolean;
  notify_digest?: boolean;
  auto_sync?: boolean;
  sync_freq?: number;
  session_timeout?: number;
  session_warn?: boolean;
  created_at?: string;
  updated_at?: string;
};
export type ConfiguracaoUpdate = Partial<ConfiguracaoInsert>;

export type BlocoConfigRow = {
  id: string;
  user_id: string;
  org_id: string;
  escopo: string;
  tipo: BlocoTipo;
  visivel: boolean;
  ordem: number;
  banda: BlocoBanda | null;
  valor: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};
export type BlocoConfigInsert = {
  id?: string;
  user_id: string;
  org_id: string;
  escopo: string;
  tipo: BlocoTipo;
  visivel?: boolean;
  ordem?: number;
  banda?: BlocoBanda | null;
  valor?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
};
export type BlocoConfigUpdate = Partial<BlocoConfigInsert>;

/** Tipo agregado compativel com o generico Database do supabase-js. */
export interface Database {
  public: {
    Tables: {
      org: {
        Row: OrgRow;
        Insert: OrgInsert;
        Update: OrgUpdate;
        Relationships: [];
      };
      org_membership: {
        Row: OrgMembershipRow;
        Insert: OrgMembershipInsert;
        Update: OrgMembershipUpdate;
        Relationships: [];
      };
      tema: {
        Row: TemaRow;
        Insert: TemaInsert;
        Update: TemaUpdate;
        Relationships: [];
      };
      configuracao: {
        Row: ConfiguracaoRow;
        Insert: ConfiguracaoInsert;
        Update: ConfiguracaoUpdate;
        Relationships: [];
      };
      bloco_config: {
        Row: BlocoConfigRow;
        Insert: BlocoConfigInsert;
        Update: BlocoConfigUpdate;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      current_user_orgs: {
        Args: Record<string, never>;
        Returns: string[];
      };
      has_papel_manutencao: {
        Args: Record<string, never>;
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
