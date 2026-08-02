import { NextResponse } from 'next/server';
import { createSession, upsertStagesnapUser } from '@/lib/auth';
import { verifyStagesnapToken } from '@/lib/auth/stagesnapSso';

const SESSION_COOKIE = 'hermes-session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const RATE_LIMIT_CAPACITY = 10;
const GLOBAL_RATE_LIMIT_CAPACITY = 15;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateLimits = new Map<string, { tokens: number; updatedAt: number }>();
let globalRateLimit: { tokens: number; updatedAt: number } | null = null;

function shouldUseSecureCookies(request: Request): boolean {
  const forced = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (forced === 'true' || forced === '1' || forced === 'yes') return true;
  if (forced === 'false' || forced === '0' || forced === 'no') return false;
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    return forwardedProto.split(',')[0].trim().toLowerCase() === 'https';
  }

  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return process.env.NODE_ENV === 'production';
  }
}

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
  current: { tokens: number; updatedAt: number } | undefined,
  capacity: number,
  now: number,
): { allowed: boolean; bucket: { tokens: number; updatedAt: number } } {
  const bucket = current ?? { tokens: capacity, updatedAt: now };
  const replenished = Math.min(
    capacity,
    bucket.tokens + ((now - bucket.updatedAt) * capacity) / RATE_LIMIT_WINDOW_MS,
  );
  return {
    allowed: replenished >= 1,
    bucket: {
      tokens: replenished >= 1 ? replenished - 1 : replenished,
      updatedAt: now,
    },
  };
}

function takeRateLimitToken(request: Request): boolean {
  const now = Date.now();
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

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie') || '';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function requestToken(request: Request): Promise<string | null> {
  const authorization = request.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
    try {
      if (contentType.includes('application/json')) {
        const body = await request.json() as { token?: unknown };
        if (typeof body?.token === 'string' && body.token.trim()) return body.token.trim();
      } else if (
        contentType.includes('application/x-www-form-urlencoded')
        || contentType.includes('multipart/form-data')
      ) {
        const token = await request.formData().then((body) => body.get('token'));
        if (typeof token === 'string' && token.trim()) return token.trim();
      }
    } catch {
      // Malformed bodies do not prevent the documented cookie fallback.
    }
  }

  return cookieValue(request, '__Host-__convexAuthJWT')
    || cookieValue(request, '__convexAuthJWT');
}

function withSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function disabledResponse(): NextResponse {
  return withSecurityHeaders(NextResponse.json({ error: 'not_found' }, { status: 404 }));
}

function invalidResponse(): NextResponse {
  return withSecurityHeaders(NextResponse.json({ error: 'invalid_sso_token' }, { status: 401 }));
}

async function authenticate(request: Request, redirect: boolean): Promise<NextResponse> {
  if (process.env.STAGESNAP_SSO_ENABLED !== 'true') return disabledResponse();
  if (!takeRateLimitToken(request)) {
    return withSecurityHeaders(NextResponse.json({ error: 'rate_limited' }, { status: 429 }));
  }

  try {
    const token = await requestToken(request);
    if (!token) return invalidResponse();

    const { sub } = await verifyStagesnapToken(token);
    const user = upsertStagesnapUser(sub);
    const sessionToken = createSession(user.id);
    const response = redirect
      ? NextResponse.redirect(new URL('/', request.url))
      : NextResponse.json({ ok: true });
    // This cross-site top-level POST/GET flow needs lax; strict would break the StageSnap navigation.
    response.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: shouldUseSecureCookies(request),
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    });
    return withSecurityHeaders(response);
  } catch {
    return invalidResponse();
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  return authenticate(request, true);
}

export async function POST(request: Request): Promise<NextResponse> {
  return authenticate(request, false);
}
