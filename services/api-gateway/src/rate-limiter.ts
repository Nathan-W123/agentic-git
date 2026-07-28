export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: number;
  allowed: boolean;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiterOptions {
  capacity?: number;
  refillPerMinute?: number;
  maxKeys?: number;
  now?: () => number;
}

/** Bounded in-memory token bucket for the local API gateway. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  public constructor(options: RateLimiterOptions = {}) {
    this.capacity = options.capacity ?? 120;
    const refillPerMinute = options.refillPerMinute ?? this.capacity;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.capacity) ||
      this.capacity < 1 ||
      !Number.isFinite(refillPerMinute) ||
      refillPerMinute <= 0 ||
      !Number.isSafeInteger(this.maxKeys) ||
      this.maxKeys < 1
    ) {
      throw new RangeError("Rate limiter values must be positive");
    }
    this.refillPerMs = refillPerMinute / 60_000;
  }

  public consume(key: string, cost = 1): RateLimit {
    if (key.length === 0 || !Number.isFinite(cost) || cost <= 0) {
      throw new RangeError("Rate-limit key and cost must be positive");
    }
    const now = this.now();
    const current = this.buckets.get(key) ?? {
      tokens: this.capacity,
      updatedAt: now,
    };
    current.tokens = Math.min(
      this.capacity,
      current.tokens + (now - current.updatedAt) * this.refillPerMs,
    );
    current.updatedAt = now;
    const allowed = current.tokens >= cost;
    if (allowed) {
      current.tokens -= cost;
    }
    this.buckets.delete(key);
    this.buckets.set(key, current);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.buckets.delete(oldest);
    }
    const missing = Math.max(0, this.capacity - current.tokens);
    return {
      limit: this.capacity,
      remaining: Math.max(0, Math.floor(current.tokens)),
      resetAt: Math.ceil(now + missing / this.refillPerMs),
      allowed,
    };
  }
}
