// =====================================================================
// _shared/cache.ts
// Cache em memoria de instancia para Edge Functions read-only.
//
// Restricao arquitetural (RNF-12): o cache NAO e distribuido. Vive no
// escopo da instancia da Edge Function. Em deploy com multiplas
// instancias o hit-rate e por instancia (intencional: simplicidade e
// zero dependencia externa para a Fase 1).
//
// Politica de evicao: LRU (Least Recently Used) com cap configuravel
// (sugestao CA-05: 10.000 entradas). Cada getOrSet() com hit promove o
// item para o final da ordem de insercao (mais recentemente usado).
//
// Politica de expiracao: TTL (time-to-live) POR ENTRADA, configurado
// pelo chamador. A entrada expirada e descartada no proximo acesso
// (lazy expiration). O cap de tamanho e enforced em todo set() que
// cria entrada nova.
//
// Observabilidade: hit/miss sao registrados em log estruturado
// (`console.info`) com chave parcial e idade_ms (quando hit). A
// metrica `cache_hit_ratio` pode ser derivada agregando esses logs.
//
// Seguranca: este cache e puramente read-through. NAO expoe nenhuma
// primitiva de escrita direta. O chamador SEMPRE passa um fetcher.
// Erros lancados pelo fetcher NAO sao cacheados.
// =====================================================================

/** Entrada armazenada no Map do cache. */
interface CacheEntry<T> {
  valor: T;
  /** Timestamp (ms) em que a entrada foi criada. */
  criadoEm: number;
  /** Timestamp (ms) em que a entrada expira. */
  expiraEm: number;
}

/** Opcoes de construcao do cache. */
export interface MemoryCacheOptions {
  /** Tamanho maximo do Map (cap de entradas). Default: 10_000 (CA-05). */
  capacity?: number;
  /** Identificador logico do cache para observabilidade. */
  label?: string;
}

const DEFAULT_CAPACITY = 10_000;

/**
 * Cache em memoria com TTL e LRU. Tipo-generico; o uso real e
 * `getOrSet<T>(key, fetcher, ttlSeconds)` em 99% dos casos.
 */
export class MemoryCache {
  private readonly map = new Map<string, CacheEntry<unknown>>();
  private readonly capacity: number;
  private readonly label: string;

  constructor(options: MemoryCacheOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.label = options.label ?? "default";
  }

  /**
   * Retorna o valor cacheado para `key` se existir e nao estiver
   * expirado; caso contrario, executa `fetcher`, cacheia o resultado
   * com TTL `ttlSeconds` e retorna. Erros lancados pelo fetcher NAO
   * sao cacheados (re-lancados imediatamente).
   *
   * Hit/miss sao registrados em log estruturado para o calculo de
   * `cache_hit_ratio`.
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: number,
  ): Promise<T> {
    const now = Date.now();
    const existing = this.map.get(key) as CacheEntry<T> | undefined;

    if (existing && existing.expiraEm > now) {
      // Hit: promove para final da ordem LRU (mais recente).
      this.map.delete(key);
      this.map.set(key, existing as CacheEntry<unknown>);
      const idadeMs = now - existing.criadoEm;
      console.info("[cache] hit", {
        cache: this.label,
        chave: this.previewKey(key),
        idade_ms: idadeMs,
        tamanho: this.map.size,
      });
      return existing.valor;
    }

    // Miss: entrada ausente OU expirada. Remove entrada expirada (se houver).
    if (existing) {
      this.map.delete(key);
    }

    const valor = await fetcher();
    this.set(key, valor, ttlSeconds, now);
    console.info("[cache] miss", {
      cache: this.label,
      chave: this.previewKey(key),
      tamanho: this.map.size,
    });
    return valor;
  }

  /** Insere (ou substitui) uma entrada com TTL. Aplica eviction LRU. */
  private set<T>(key: string, valor: T, ttlSeconds: number, now: number): void {
    const ttlMs = Math.max(1, Math.floor(ttlSeconds * 1000));
    const entry: CacheEntry<T> = {
      valor,
      criadoEm: now,
      expiraEm: now + ttlMs,
    };

    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, entry as CacheEntry<unknown>);

    // Eviction LRU: enquanto o tamanho estourar, remove o item mais
    // antigo (primeiro da ordem de insercao do Map).
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Tamanho atual do cache (entradas validas OU expiradas - lazy). */
  size(): number {
    return this.map.size;
  }

  /** Limpa o cache. Util para testes e para forcar reset apos mutacao. */
  clear(): void {
    this.map.clear();
  }

  /**
   * Retorna uma versao reduzida da chave para logging (evita vazar
   * blobs grandes). Mantemos o prefixo e a quantidade de segmentos.
   */
  private previewKey(key: string): string {
    if (key.length <= 80) return key;
    return key.slice(0, 60) + `...(len=${key.length})`;
  }
}

// ---------------------------------------------------------------------
// Instancias nomeadas por escopo de uso.
//
// Cada Edge Function cria (ou reusa) uma instancia por escopo. Sao
// declaradas aqui para compartilhar entre chamadas dentro da mesma
// instancia da Edge - o Map vive no escopo do worker do Deno.
// ---------------------------------------------------------------------

const caches = new Map<string, MemoryCache>();

/**
 * Retorna (ou cria) a instancia singleton de MemoryCache para o
 * `label` informado. Garante que duas chamadas com o mesmo label
// compartilham o mesmo Map dentro da instancia.
 */
export function getMemoryCache(label: string, options?: MemoryCacheOptions): MemoryCache {
  const existente = caches.get(label);
  if (existente) return existente;
  const criado = new MemoryCache({ ...options, label });
  caches.set(label, criado);
  return criado;
}

/**
 * Atalhos para o caso de uso comum (getOrSet em cache singleton).
 * Mantem o call site das Edges limpo.
 */
export function cacheGetOrSet<T>(
  label: string,
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number,
  options?: MemoryCacheOptions,
): Promise<T> {
  return getMemoryCache(label, options).getOrSet(key, fetcher, ttlSeconds);
}
