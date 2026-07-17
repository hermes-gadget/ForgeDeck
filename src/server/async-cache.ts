/** A small stale-free cache that also coalesces concurrent refreshes. */
export class AsyncTtlCache<T> {
  private value: T | undefined;
  private expiresAt = 0;
  private refresh: Promise<T> | null = null;

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(load: () => Promise<T>): Promise<T> {
    if (this.value !== undefined && this.expiresAt > this.now()) return Promise.resolve(this.value);
    if (this.refresh) return this.refresh;
    const refresh = load().then((value) => {
      this.value = value;
      this.expiresAt = this.now() + this.ttlMs;
      return value;
    }).finally(() => {
      if (this.refresh === refresh) this.refresh = null;
    });
    this.refresh = refresh;
    return refresh;
  }

  clear(): void {
    this.value = undefined;
    this.expiresAt = 0;
  }
}

/** A bounded keyed cache that coalesces concurrent loads and supports safe invalidation. */
export class KeyedAsyncTtlCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: T }>();
  private readonly pending = new Map<string, Promise<T>>();
  private generation = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 256,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError("Cache TTL must be non-negative");
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("Cache maximum must be positive");
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);
    if (cached) this.entries.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    let request: Promise<T>;
    // The promise is referenced by its own cleanup callback, so it cannot be a const initializer.
    // eslint-disable-next-line prefer-const
    request = Promise.resolve().then(load).then((value) => {
      if (this.generation === generation) {
        this.pruneExpired();
        while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value });
      }
      return value;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.pending.clear();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}
