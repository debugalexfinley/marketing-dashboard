/**
 * Rate limiting for the StageSnap SSO endpoint.
 *
 * Lives outside the route module because Next.js App Router route files may only
 * export recognized handlers (GET/POST/config/...); exporting the test-reset
 * helper from `route.ts` makes `next build` fail its route-type validation.
 *
 * Per-process and in-memory: it does not coordinate across instances. The
 * per-key bucket keys on client IP only when TRUSTED_PROXY is set (a proxy that
 * OVERWRITES the forwarded headers); the global bucket is the backstop that
 * bounds JWKS fetch amplification when the key is spoofable.
 */

const RATE_LIMIT_CAPACITY = 10;
const GLOBAL_RATE_LIMIT_CAPACITY = 15;
const RATE_LIMIT_WINDOW_MS = 60_000;

type Bucket = { tokens: number; updatedAt: number };

const rateLimits = new Map<string, Bucket>();
let globalRateLimit: Bucket | null = null;

function clientIp(request: Request): string {
  if (process.env.TRUSTED_PROXY === 'true') {
    // Safe only behind a trusted proxy that OVERWRITES (not appends to) these headers.
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    return forwarded || request.headers.get('x-real-ip')?.trim() || 'proxied-unknown';
  }

  // Standard Route Handler Requests expose no platform connection IP.
  return 'unproxied';
}

function takeBucketToken(
  current: Bucket | undefined,
  capacity: number,
  now: number,
): { allowed: boolean; bucket: Bucket } {
  const bucket = current ?? { tokens: capacity, updatedAt: now };
  const refilled = Math.min(
    capacity,
    bucket.tokens + ((now - bucket.updatedAt) * capacity) / RATE_LIMIT_WINDOW_MS,
  );

  if (refilled < 1) {
    return { allowed: false, bucket: { tokens: refilled, updatedAt: now } };
  }

  return { allowed: true, bucket: { tokens: refilled - 1, updatedAt: now } };
}

/** Consume one token from both the per-client and global buckets. */
export function allowSsoRequest(request: Request, now = Date.now()): boolean {
  const key = clientIp(request);
  const perKey = takeBucketToken(rateLimits.get(key), RATE_LIMIT_CAPACITY, now);
  const global = takeBucketToken(globalRateLimit ?? undefined, GLOBAL_RATE_LIMIT_CAPACITY, now);
  rateLimits.set(key, perKey.bucket);
  globalRateLimit = global.bucket;
  return perKey.allowed && global.allowed;
}

export function resetSsoRateLimitsForTests(): void {
  rateLimits.clear();
  globalRateLimit = null;
}
