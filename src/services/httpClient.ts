export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly bodyPreview?: string;

  constructor(status: number, url: string, message?: string, bodyPreview?: string) {
    super(message ?? `HTTP ${status} from ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.bodyPreview = bodyPreview;
  }
}

export class CircuitOpenError extends Error {
  readonly key: string;
  readonly retryAfterMs: number;

  constructor(key: string, retryAfterMs: number) {
    super(`Circuit breaker open for "${key}" (retry in ${Math.ceil(retryAfterMs / 1000)}s)`);
    this.name = 'CircuitOpenError';
    this.key = key;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface FetchTimeoutOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: HeadersInit;
  init?: Omit<RequestInit, 'signal' | 'headers'>;
}

/**
 * Execute fetch() guarded by an AbortController timeout and optional external AbortSignal.
 * Throws HttpError on non-2xx responses so callers handle failures uniformly.
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchTimeoutOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const controller = new AbortController();
  const externalSignal = options.signal;

  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason ?? new DOMException('Aborted', 'AbortError'));
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'AbortError'));
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options.init,
      headers: options.headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      let preview: string | undefined;
      try {
        const text = await response.text();
        preview = text.slice(0, 200);
      } catch {
        preview = undefined;
      }
      throw new HttpError(
        response.status,
        url,
        `HTTP ${response.status} ${response.statusText || ''}`.trim(),
        preview
      );
    }

    return response;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Fetch and parse JSON safely with AbortController timeout.
 */
export async function fetchJsonWithTimeout<T = unknown>(
  url: string,
  options: FetchTimeoutOptions = {}
): Promise<T> {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...options.headers,
    },
  });
  return (await response.json()) as T;
}

/**
 * Fetch plain text safely with AbortController timeout.
 */
export async function fetchTextWithTimeout(
  url: string,
  options: FetchTimeoutOptions = {}
): Promise<string> {
  const response = await fetchWithTimeout(url, options);
  return await response.text();
}

export interface TokenBucketOptions {
  /** Minimum interval between refills/consumes in milliseconds (default: 10000ms). */
  minIntervalMs?: number;
  /** Maximum tokens held per key (default: 1). */
  capacity?: number;
  /** Optional clock provider for deterministic tests. */
  nowFn?: () => number;
}

interface BucketEntry {
  tokens: number;
  lastRefillMs: number;
  lastConsumedMs: number;
}

/**
 * Per-key TokenBucketRateLimiter enforcing strict cooldown intervals (default 10s for ADS-B).
 */
export class TokenBucketRateLimiter {
  readonly minIntervalMs: number;
  readonly capacity: number;
  private readonly nowFn: () => number;
  private readonly buckets = new Map<string, BucketEntry>();

  constructor(optionsOrIntervalMs: TokenBucketOptions | number = {}) {
    if (typeof optionsOrIntervalMs === 'number') {
      this.minIntervalMs = Math.max(0, optionsOrIntervalMs);
      this.capacity = 1;
      this.nowFn = () => Date.now();
    } else {
      this.minIntervalMs = Math.max(0, optionsOrIntervalMs.minIntervalMs ?? 10_000);
      this.capacity = Math.max(1, optionsOrIntervalMs.capacity ?? 1);
      this.nowFn = optionsOrIntervalMs.nowFn ?? (() => Date.now());
    }
  }

  private getOrCreateRefilledBucket(key: string, now: number): BucketEntry {
    const existing = this.buckets.get(key);
    if (!existing) {
      const fresh: BucketEntry = {
        tokens: this.capacity,
        lastRefillMs: now,
        lastConsumedMs: -Infinity,
      };
      this.buckets.set(key, fresh);
      return fresh;
    }

    if (this.minIntervalMs > 0 && now > existing.lastRefillMs) {
      const elapsed = now - existing.lastRefillMs;
      const added = elapsed / this.minIntervalMs;
      existing.tokens = Math.min(this.capacity, existing.tokens + added);
      existing.lastRefillMs = now;
    } else if (this.minIntervalMs === 0) {
      existing.tokens = this.capacity;
      existing.lastRefillMs = now;
    }

    return existing;
  }

  canConsume(key: string, cost = 1): boolean {
    const now = this.nowFn();
    const bucket = this.getOrCreateRefilledBucket(key, now);
    if (this.minIntervalMs > 0 && now - bucket.lastConsumedMs < this.minIntervalMs) {
      return false;
    }
    return bucket.tokens >= cost;
  }

  tryConsume(key: string, cost = 1): boolean {
    const now = this.nowFn();
    const bucket = this.getOrCreateRefilledBucket(key, now);
    if (this.minIntervalMs > 0 && now - bucket.lastConsumedMs < this.minIntervalMs) {
      return false;
    }
    if (bucket.tokens < cost) {
      return false;
    }
    bucket.tokens -= cost;
    bucket.lastConsumedMs = now;
    return true;
  }

  getWaitMs(key: string, cost = 1): number {
    const now = this.nowFn();
    const bucket = this.getOrCreateRefilledBucket(key, now);
    const intervalWait =
      this.minIntervalMs > 0 && Number.isFinite(bucket.lastConsumedMs)
        ? Math.max(0, this.minIntervalMs - (now - bucket.lastConsumedMs))
        : 0;
    const tokenShortfall = Math.max(0, cost - bucket.tokens);
    const tokenWait = this.minIntervalMs > 0 ? tokenShortfall * this.minIntervalMs : 0;
    return Math.ceil(Math.max(intervalWait, tokenWait));
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.buckets.clear();
    } else {
      this.buckets.delete(key);
    }
  }
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxCalls?: number;
  nowFn?: () => number;
}

interface BreakerEntry {
  state: CircuitState;
  failures: number;
  openedAtMs: number;
  halfOpenInFlight: number;
  lastError?: unknown;
}

/**
 * Keyed CircuitBreaker protecting external feeds from cascading timeout storms.
 */
export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxCalls: number;
  private readonly nowFn: () => number;
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.resetTimeoutMs = Math.max(100, options.resetTimeoutMs ?? 30_000);
    this.halfOpenMaxCalls = Math.max(1, options.halfOpenMaxCalls ?? 1);
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  private getEntry(key: string): BreakerEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        state: 'closed',
        failures: 0,
        openedAtMs: 0,
        halfOpenInFlight: 0,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  getState(key = 'default'): CircuitState {
    const entry = this.getEntry(key);
    if (entry.state === 'open') {
      const elapsed = this.nowFn() - entry.openedAtMs;
      if (elapsed >= this.resetTimeoutMs) {
        entry.state = 'half-open';
        entry.halfOpenInFlight = 0;
      }
    }
    return entry.state;
  }

  canExecute(key = 'default'): boolean {
    const state = this.getState(key);
    if (state === 'closed') return true;
    if (state === 'open') return false;
    const entry = this.getEntry(key);
    return entry.halfOpenInFlight < this.halfOpenMaxCalls;
  }

  recordSuccess(key = 'default'): void {
    const entry = this.getEntry(key);
    entry.state = 'closed';
    entry.failures = 0;
    entry.openedAtMs = 0;
    entry.halfOpenInFlight = 0;
    entry.lastError = undefined;
  }

  recordFailure(key = 'default', error?: unknown): void {
    const entry = this.getEntry(key);
    if (error !== undefined) {
      entry.lastError = error;
    }
    if (entry.state === 'half-open') {
      entry.state = 'open';
      entry.openedAtMs = this.nowFn();
      entry.halfOpenInFlight = 0;
      entry.failures = this.failureThreshold;
      return;
    }

    entry.failures += 1;
    if (entry.failures >= this.failureThreshold) {
      entry.state = 'open';
      entry.openedAtMs = this.nowFn();
      entry.halfOpenInFlight = 0;
    }
  }

  getLastError(key = 'default'): unknown {
    return this.entries.get(key)?.lastError;
  }

  async execute<T>(fn: () => Promise<T>, key = 'default'): Promise<T> {
    const state = this.getState(key);
    const entry = this.getEntry(key);

    if (state === 'open') {
      const retryAfter = Math.max(0, this.resetTimeoutMs - (this.nowFn() - entry.openedAtMs));
      throw new CircuitOpenError(key, retryAfter);
    }

    if (state === 'half-open') {
      if (entry.halfOpenInFlight >= this.halfOpenMaxCalls) {
        throw new CircuitOpenError(key, 1000);
      }
      entry.halfOpenInFlight += 1;
    }

    try {
      const result = await fn();
      this.recordSuccess(key);
      return result;
    } catch (error) {
      this.recordFailure(key, error);
      throw error;
    }
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
    } else {
      this.entries.delete(key);
    }
  }
}
