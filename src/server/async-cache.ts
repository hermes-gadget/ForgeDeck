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
