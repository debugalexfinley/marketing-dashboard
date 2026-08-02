import { NextResponse } from 'next/server';
import { createSession, upsertStagesnapUser } from '@/lib/auth';
import { verifyStagesnapToken } from '@/lib/auth/stagesnapSso';

const SESSION_COOKIE = 'hermes-session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const RATE_LIMIT_CAPACITY = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateLimits = new Map<string, { tokens: number; updatedAt: number }>();

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
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

function takeRateLimitToken(request: Request): boolean {
  const now = Date.now();
  const key = clientIp(request);
  const current = rateLimits.get(key) ?? { tokens: RATE_LIMIT_CAPACITY, updatedAt: now };
  const replenished = Math.min(
    RATE_LIMIT_CAPACITY,
    current.tokens + ((now - current.updatedAt) * RATE_LIMIT_CAPACITY) / RATE_LIMIT_WINDOW_MS,
  );
  if (replenished < 1) {
    rateLimits.set(key, { tokens: replenished, updatedAt: now });
    return false;
  }
  rateLimits.set(key, { tokens: replenished - 1, updatedAt: now });
  return true;
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

function requestToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  const queryToken = new URL(request.url).searchParams.get('token')?.trim();
  if (queryToken) return queryToken;

  return cookieValue(request, '__Host-__convexAuthJWT')
    || cookieValue(request, '__convexAuthJWT');
}

function disabledResponse(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

function invalidResponse(): NextResponse {
  return NextResponse.json({ error: 'invalid_sso_token' }, { status: 401 });
}

async function authenticate(request: Request, redirect: boolean): Promise<NextResponse> {
  if (process.env.STAGESNAP_SSO_ENABLED !== 'true') return disabledResponse();
  if (!takeRateLimitToken(request)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  try {
    const token = requestToken(request);
    if (!token) return invalidResponse();

    const { sub } = await verifyStagesnapToken(token);
    const user = upsertStagesnapUser(sub);
    const sessionToken = createSession(user.id);
    const response = redirect
      ? NextResponse.redirect(new URL('/', request.url))
      : NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: shouldUseSecureCookies(request),
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    });
    return response;
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
