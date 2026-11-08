import { isUpstreamPressure } from './errors';
import type { Logger } from './log';

/**
 * Every cached value is wrapped with its own freshness. `freshUntil` is the soft
 * window; the KV expiry is later, so a stale entry can still be served when
 * upstream is throttling or down (PLAN-v1.md §5).
 */
export interface CacheEntry<T> {
  value: T;
  cachedAt: number;
  freshUntil: number;
}

export interface Loaded<T> {
  value: T;
  /** Epoch ms after which the entry is stale and a refetch is attempted. */
  freshUntil: number;
  /** Epoch ms after which KV drops the entry entirely. */
  retainUntil: number;
}

// KV rejects expirations less than 60 seconds away.
const KV_MIN_TTL_S = 60;

/** The key's kind (`clips`, `profile`, ...), for counting; the key itself may hold a gamertag or XUID. */
const prefixOf = (key: string) => key.split(':', 1)[0];

export class Cache {
  constructor(
    private readonly kv: KVNamespace,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {}

  /** A plain read, whatever the entry's freshness: logged as a hit if there is one. */
  async read<T>(key: string): Promise<CacheEntry<T> | null> {
    const entry = await this.get<T>(key);
    this.logRead(key, entry ? 'hit' : 'miss');
    return entry;
  }

  private async get<T>(key: string): Promise<CacheEntry<T> | null> {
    try {
      return await this.kv.get<CacheEntry<T>>(key, 'json');
    } catch (err) {
      this.log.emit('cache.read_failed', { prefix: prefixOf(key), key, error: err });
      return null;
    }
  }

  /**
   * One `cache.read` per KV read, so reads can be set against writes and against
   * KV's 100,000 reads a day (PLAN-v1.md §11.5). `expired`: an entry past its
   * freshness, refetched; `stale`: one served anyway because upstream was under
   * pressure.
   */
  private logRead(key: string, outcome: 'hit' | 'miss' | 'expired' | 'stale'): void {
    this.log.emit('cache.read', { prefix: prefixOf(key), outcome });
  }

  /**
   * KV stores strings, so the entry is JSON-encoded here exactly once and decoded
   * by `get(key, 'json')`. Never pass a pre-stringified value (PLAN-v1.md §3).
   *
   * A failed write is logged and swallowed: losing a cache write costs a future
   * upstream call, while failing the request would cost this one.
   */
  async write<T>(key: string, value: T, freshUntil: number, retainUntil: number): Promise<void> {
    const now = this.now();
    const entry: CacheEntry<T> = { value, cachedAt: now, freshUntil };
    const ttl = Math.max(KV_MIN_TTL_S, Math.ceil((retainUntil - now) / 1000));
    try {
      await this.kv.put(key, JSON.stringify(entry), { expirationTtl: ttl });
      // Counted against KV's 1,000 writes a day (PLAN-v1.md §11.5).
      this.log.emit('cache.written', { prefix: prefixOf(key) });
    } catch (err) {
      this.log.emit('cache.write_failed', { prefix: prefixOf(key), key, error: err });
    }
  }

  /**
   * Read-through with stale fallback. Returns the fresh entry if there is one;
   * otherwise loads, stores and returns. If loading fails because upstream is
   * under pressure and a stale entry exists, returns the stale value passed
   * through `onStale`, which lets callers strip anything that must not be served
   * stale (expired media URLs). A `null` load result is returned but not stored.
   */
  async readThrough<T>(
    key: string,
    load: () => Promise<Loaded<T> | null>,
    onStale: (value: T) => T = (v) => v,
  ): Promise<T | null> {
    const entry = await this.get<T>(key);
    if (entry && this.now() < entry.freshUntil) {
      this.logRead(key, 'hit');
      return entry.value;
    }

    let loaded: Loaded<T> | null;
    try {
      loaded = await load();
    } catch (err) {
      if (entry && isUpstreamPressure(err)) {
        this.logRead(key, 'stale');
        return onStale(entry.value);
      }
      this.logRead(key, entry ? 'expired' : 'miss');
      throw err;
    }
    this.logRead(key, entry ? 'expired' : 'miss');
    if (!loaded) return null;
    await this.write(key, loaded.value, loaded.freshUntil, loaded.retainUntil);
    return loaded.value;
  }
}
