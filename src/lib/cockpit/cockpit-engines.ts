// =====================================================================
// cockpit/cockpit-engines.ts — registro de motores do cockpit (delta-18/19).
//
// ENGINES é o registro de motores do cockpit, cada um com hooks de ciclo de
// vida: `init` (boot da app), `cockpit` (montagem da view), `config` (mudança
// de configuração) e `refresh` (re-leitura das fontes). `ENGINES.hook(name)`
// dispara o hook homônimo em todos os motores registrados.
//
// `refresh` também notifica assinantes voláteis (ex.: o hook React de métricas
// registra seu refetch), permitindo que `refreshCockpit()` force uma releitura
// read-only das execucoes sem acoplar o registro ao React.
// =====================================================================

/** Hooks de ciclo de vida disparáveis em um motor do cockpit. */
export type CockpitHookName = "init" | "cockpit" | "config" | "refresh";

/** Um motor do cockpit: id + hooks opcionais. */
export interface CockpitEngine {
  id: string;
  init?: () => void;
  cockpit?: () => void;
  config?: () => void;
  refresh?: () => void;
}

const engines = new Map<string, CockpitEngine>();
const refreshSubscribers = new Set<() => void>();

/** API do registro de motores do cockpit. */
export const ENGINES = {
  /** Registra um motor; devolve o de-registro idempotente. */
  register(engine: CockpitEngine): () => void {
    engines.set(engine.id, engine);
    return () => {
      engines.delete(engine.id);
    };
  },
  /** Motores registrados (cópia defensiva). */
  list(): CockpitEngine[] {
    return [...engines.values()];
  },
  /** Dispara o hook homônimo em todos os motores (e assinantes, no refresh). */
  hook(name: CockpitHookName): void {
    for (const engine of engines.values()) {
      engine[name]?.();
    }
    if (name === "refresh") {
      for (const cb of refreshSubscribers) cb();
    }
  },
  /** Assina o refresh volátil (ex.: refetch React); devolve o cancelamento. */
  onRefresh(cb: () => void): () => void {
    refreshSubscribers.add(cb);
    return () => {
      refreshSubscribers.delete(cb);
    };
  },
} as const;

/** Reaplica o cockpit: dispara `ENGINES.hook('refresh')`. */
export function refreshCockpit(): void {
  ENGINES.hook("refresh");
}
