import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';

const tempDir = mkdtempSync(path.join(tmpdir(), 'hermes-stagesnap-sso-test-'));
const dbPath = path.join(tempDir, 'hermes-test.db');

process.env.HERMES_DB_PATH = dbPath;
process.env.AUTH_COOKIE_SECURE = 'false';

import { GET, POST, resetSsoRateLimitsForTests } from '@/app/api/auth/sso/route';
import { requireApiAdmin, requireApiCapability, requireApiEditor } from '@/lib/api-auth';
import {
  createSession,
  createUser,
  ensureAuthTables,
  requireAdmin,
  updateUserRole,
  upsertStagesnapUser,
  validateSession,
} from '@/lib/auth';
import { verifyStagesnapToken } from '@/lib/auth/stagesnapSso';
import { getDb, resetDbForTests } from '@/lib/db';
import { roleHasCapability } from '@/lib/rbac';

const PROD_AUDIENCE = 'convex';
const TEST_SUB = 'stagesnap-user-123';

let trustedPrivateKey: CryptoKey;
let trustedJwk: JWK;
let unrelatedPrivateKey: CryptoKey;
let unrelatedJwk: JWK;
let requestIp = 0;
let issuerNumber = 0;

before(async () => {
  const trusted = await generateKeyPair('RS256', { extractable: true });
  trustedPrivateKey = trusted.privateKey;
  trustedJwk = {
    ...(await exportJWK(trusted.publicKey)),
    alg: 'RS256',
    kid: 'trusted-key',
    use: 'sig',
  };

  const unrelated = await generateKeyPair('RS256', { extractable: true });
  unrelatedPrivateKey = unrelated.privateKey;
  unrelatedJwk = {
    ...(await exportJWK(unrelated.publicKey)),
    alg: 'RS256',
    kid: 'unrelated-key',
    use: 'sig',
  };
});

beforeEach(() => {
  process.env.STAGESNAP_SSO_ENABLED = 'true';
  process.env.STAGESNAP_SSO_AUDIENCE = PROD_AUDIENCE;
  process.env.STAGESNAP_SSO_JWKS_TTL_MS = '600000';
  delete process.env.TRUSTED_PROXY;
  resetSsoRateLimitsForTests();
  ensureAuthTables();
  getDb().exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM google_login_requests;');
});

after(() => {
  resetDbForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

async function withJwks<T>(
  keys: JWK[],
  run: (issuer: string, requestCount: () => number) => Promise<T>,
  status = 200,
): Promise<T> {
  let requests = 0;
  issuerNumber += 1;
  const issuer = `https://issuer-${issuerNumber}.stagesnap.test`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `${issuer}/.well-known/jwks.json`);
    requests += 1;
    return Response.json({ keys }, { status });
  };
  try {
    return await run(issuer, () => requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function configureIssuer(issuer: string): void {
  process.env.STAGESNAP_SSO_ISSUERS = issuer;
}

async function signedToken(
  issuer: string,
  options: {
    audience?: string;
    exp?: number;
    key?: CryptoKey;
    kid?: string;
    nbf?: number;
    sub?: string;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let token = new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'trusted-key' })
    .setIssuer(issuer)
    .setAudience(options.audience ?? PROD_AUDIENCE)
    .setSubject(options.sub ?? TEST_SUB)
    .setIssuedAt(now)
    .setExpirationTime(options.exp ?? now + 300);
  if (options.nbf !== undefined) token = token.setNotBefore(options.nbf);
  return token.sign(options.key ?? trustedPrivateKey);
}

function unsecuredToken(issuer: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud: PROD_AUDIENCE,
    exp: now + 300,
    iss: issuer,
    sub: TEST_SUB,
  })).toString('base64url');
  return `${header}.${payload}.`;
}

async function hmacToken(issuer: string): Promise<string> {
  const modulus = trustedJwk.n;
  if (typeof modulus !== 'string') throw new Error('Generated RSA JWK is missing its modulus');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', kid: 'trusted-key' })
    .setIssuer(issuer)
    .setAudience(PROD_AUDIENCE)
    .setSubject(TEST_SUB)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(Buffer.from(modulus, 'base64url'));
}

function request(url: string, init: RequestInit = {}): Request {
  requestIp += 1;
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', `192.0.2.${requestIp}`);
  return new Request(url, { ...init, headers });
}

function assertSecurityHeaders(response: Response): void {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
}

async function captureConsole(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const originals = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const capture = (...values: unknown[]) => lines.push(values.map(String).join(' '));
  console.error = capture;
  console.info = capture;
  console.log = capture;
  console.warn = capture;
  try {
    await run();
  } finally {
    console.error = originals.error;
    console.info = originals.info;
    console.log = originals.log;
    console.warn = originals.warn;
  }
  return lines;
}

function assertNoTokenOrSubject(lines: string[], token: string, sub: string): void {
  assert.equal(lines.some((line) => line.includes(token)), false);
  assert.equal(lines.some((line) => line.includes(sub)), false);
}

test('1. valid token returns 200, sets a session cookie, and upserts a tenant user', async () => {
  await withJwks([trustedJwk], async (issuer) => {
    configureIssuer(issuer);
    const token = await signedToken(issuer);
    const response = await POST(request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }));

    assert.equal(response.status, 200);
    assertSecurityHeaders(response);
    assert.deepEqual(await response.json(), { ok: true });
    const setCookie = response.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^hermes-session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=lax/i);
    assert.match(setCookie, /Max-Age=604800/i);
    assert.match(setCookie, /Path=\//i);

    const sessionToken = setCookie.match(/^hermes-session=([^;]+)/)?.[1];
    assert.ok(sessionToken);
    const user = validateSession(sessionToken);
    assert.ok(user);
    assert.equal(user.username, `stagesnap:${TEST_SUB}`);
    assert.equal(user.role, 'tenant');
    assert.equal(user.auth_provider, 'stagesnap');
  });
});

test('2. expired and not-yet-valid tokens return 401', async () => {
  await withJwks([trustedJwk], async (issuer) => {
    configureIssuer(issuer);
    const now = Math.floor(Date.now() / 1000);
    const expired = await signedToken(issuer, { exp: now - 120 });
    const future = await signedToken(issuer, { nbf: now + 120 });

    for (const token of [expired, future]) {
      const response = await POST(request('http://dashboard.test/api/auth/sso', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }));
      assert.equal(response.status, 401);
      assertSecurityHeaders(response);
      assert.deepEqual(await response.json(), { error: 'invalid_sso_token' });
    }
  });
});

test('3. a dev issuer is rejected when only production is configured', async () => {
  await withJwks([trustedJwk], async (prodIssuer) => {
    configureIssuer(prodIssuer);
    const token = await signedToken('https://dev.stagesnap.invalid');
    const response = await POST(request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(response.status, 401);
  });
});

test('4. wrong audience is rejected when an audience is configured', async () => {
  await withJwks([trustedJwk], async (issuer) => {
    configureIssuer(issuer);
    const token = await signedToken(issuer, { audience: 'wrong-audience' });
    const response = await POST(request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(response.status, 401);
  });
});

test('4b. enabled SSO rejects every token when audience is unset or empty', async () => {
  await withJwks([trustedJwk], async (issuer) => {
    configureIssuer(issuer);
    const token = await signedToken(issuer);

    for (const audience of [undefined, '']) {
      if (audience === undefined) delete process.env.STAGESNAP_SSO_AUDIENCE;
      else process.env.STAGESNAP_SSO_AUDIENCE = audience;
      await assert.rejects(() => verifyStagesnapToken(token), /^Error: Invalid StageSnap SSO token$/);
    }
  });
});

test('5b. subjects with slashes, whitespace, or excessive length are rejected', async () => {
  await withJwks([trustedJwk], async (issuer) => {
    configureIssuer(issuer);
    for (const sub of ['tenant/user', 'tenant user', 'x'.repeat(500)]) {
      const token = await signedToken(issuer, { sub });
      await assert.rejects(() => verifyStagesnapToken(token), /^Error: Invalid StageSnap SSO token$/);
    }
  });
});

test('5. alg:none and HS256 signed with the RSA modulus are rejected', async () => {
  await withJwks([trustedJwk], async (issuer) => {
    configureIssuer(issuer);
    for (const token of [unsecuredToken(issuer), await hmacToken(issuer)]) {
      const response = await POST(request('http://dashboard.test/api/auth/sso', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'invalid_sso_token' });
    }
  });
});

test('6. signature by an unrelated key is rejected', async () => {
  await withJwks([trustedJwk], async (issuer) => {
    configureIssuer(issuer);
    const sub = 'private-signature-subject';
    const token = await signedToken(issuer, { key: unrelatedPrivateKey, sub });
    const lines = await captureConsole(async () => {
      await assert.rejects(() => verifyStagesnapToken(token), /^Error: Invalid StageSnap SSO token$/);
    });
    assertNoTokenOrSubject(lines, token, sub);
  });
});

test('7. unknown kid causes exactly one JWKS refetch and is then rejected', async () => {
  await withJwks([trustedJwk], async (issuer, requestCount) => {
    configureIssuer(issuer);
    const token = await signedToken(issuer, { key: unrelatedPrivateKey, kid: 'unknown-key' });
    await assert.rejects(() => verifyStagesnapToken(token), /^Error: Invalid StageSnap SSO token$/);
    assert.equal(requestCount(), 2);
  });
});

test('8. unset feature flag returns 404', async () => {
  delete process.env.STAGESNAP_SSO_ENABLED;
  const response = await GET(request('http://dashboard.test/api/auth/sso'));
  assert.equal(response.status, 404);
  assertSecurityHeaders(response);
});

test('9. rate limiter rejects the eleventh request from one trusted forwarded IP', async () => {
  process.env.TRUSTED_PROXY = 'true';
  const headers = { 'x-forwarded-for': '198.51.100.10' };
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await POST(new Request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      headers,
    }));
    assert.equal(response.status, 401);
  }
  const limited = await POST(new Request('http://dashboard.test/api/auth/sso', {
    method: 'POST',
    headers,
  }));
  assert.equal(limited.status, 429);
  assertSecurityHeaders(limited);
  assert.deepEqual(await limited.json(), { error: 'rate_limited' });
});

test('9b. spoofed forwarded IP rotation is ignored when TRUSTED_PROXY is unset', async () => {
  let limited = false;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const response = await POST(new Request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      headers: { 'x-forwarded-for': `198.51.100.${attempt}` },
    }));
    if (response.status === 429) limited = true;
  }
  assert.equal(limited, true);
});

test('9c. global rate limit rejects rotation across trusted per-IP buckets', async () => {
  process.env.TRUSTED_PROXY = 'true';
  let limited = false;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const response = await POST(new Request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      headers: { 'x-forwarded-for': `203.0.113.${attempt}` },
    }));
    if (response.status === 429) limited = true;
  }
  assert.equal(limited, true);
});

test('10. failures do not log the token or subject', async () => {
  const issuer = 'https://untrusted.stagesnap.invalid';
  configureIssuer('https://trusted.stagesnap.invalid');
  const sub = 'private-subject-value';
  const token = await signedToken(issuer, { sub });
  const lines = await captureConsole(async () => {
    const response = await POST(request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(response.status, 401);
  });
  assertNoTokenOrSubject(lines, token, sub);

  await withJwks([], async (failingIssuer) => {
    configureIssuer(failingIssuer);
    const fetchSub = 'private-jwks-fetch-subject';
    const fetchToken = await signedToken(failingIssuer, { sub: fetchSub });
    const fetchLines = await captureConsole(async () => {
      await assert.rejects(
        () => verifyStagesnapToken(fetchToken),
        /^Error: Invalid StageSnap SSO token$/,
      );
    });
    assertNoTokenOrSubject(fetchLines, fetchToken, fetchSub);
  }, 503);

  await withJwks([trustedJwk], async (collisionIssuer) => {
    configureIssuer(collisionIssuer);
    const collisionSub = 'private-upsert-subject';
    const collisionToken = await signedToken(collisionIssuer, { sub: collisionSub });
    getDb().prepare(
      "INSERT INTO users (username, password_hash, role, auth_provider) VALUES (?, ?, 'viewer', 'local')",
    ).run(`stagesnap:${collisionSub}`, 'existing-password-hash');
    const collisionLines = await captureConsole(async () => {
      const response = await POST(request('http://dashboard.test/api/auth/sso', {
        method: 'POST',
        headers: { authorization: `Bearer ${collisionToken}` },
      }));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'invalid_sso_token' });
    });
    assertNoTokenOrSubject(collisionLines, collisionToken, collisionSub);
  });
});

test('tenant sessions remain tenant and have no admin, editor, or dashboard-read privileges', async () => {
  let user = upsertStagesnapUser('privilege-boundary-user');
  assert.equal(user.role, 'tenant');
  getDb().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  user = upsertStagesnapUser('privilege-boundary-user');
  assert.equal(user.role, 'tenant');
  const sessionToken = createSession(user.id);
  const sessionUser = validateSession(sessionToken);
  assert.ok(sessionUser);
  assert.equal(sessionUser.role, 'tenant');

  const tenantRequest = new Request('http://dashboard.test/api/test', {
    headers: { cookie: `hermes-session=${sessionToken}` },
  });
  assert.throws(() => requireAdmin(tenantRequest), /^Error: forbidden$/);
  assert.equal(requireApiAdmin(tenantRequest)?.status, 403);
  assert.equal(requireApiEditor(tenantRequest)?.status, 403);
  assert.equal(requireApiCapability(tenantRequest, 'read_dashboard')?.status, 403);
  assert.equal(roleHasCapability('tenant' as never, 'read_dashboard'), false);

  assert.throws(
    () => createUser('tenant-via-admin', 'long-enough-password', 'tenant'),
    /^Error: Invalid role$/,
  );
  assert.throws(
    () => updateUserRole(user.id, 'tenant'),
    /^Error: Invalid role$/,
  );
});

test('token source precedence is Authorization, POST body, then StageSnap cookies', async () => {
  await withJwks([trustedJwk], async (issuer, requestCount) => {
    configureIssuer(issuer);
    const valid = await signedToken(issuer);
    const invalid = 'not-a-jwt';

    const headerWins = await POST(request(
      `http://dashboard.test/api/auth/sso?token=${encodeURIComponent(invalid)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${valid}`,
          cookie: `__Host-__convexAuthJWT=${encodeURIComponent(invalid)}`,
        },
      },
    ));
    assert.equal(headerWins.status, 200);

    const jsonBodyWorks = await POST(request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__Host-__convexAuthJWT=${encodeURIComponent(invalid)}`,
      },
      body: JSON.stringify({ token: valid }),
    }));
    assert.equal(jsonBodyWorks.status, 200);

    const formBodyWorks = await POST(request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      body: new URLSearchParams({ token: valid }),
    }));
    assert.equal(formBodyWorks.status, 200);

    const multipartBody = new FormData();
    multipartBody.set('token', valid);
    const multipartBodyWorks = await POST(request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      body: multipartBody,
    }));
    assert.equal(multipartBodyWorks.status, 200);

    const cookieWorks = await POST(request('http://dashboard.test/api/auth/sso', {
      method: 'POST',
      headers: { cookie: `__convexAuthJWT=${encodeURIComponent(valid)}` },
    }));
    assert.equal(cookieWorks.status, 200);

    const getHop = await GET(request('http://dashboard.test/api/auth/sso', {
      headers: { cookie: `__Host-__convexAuthJWT=${encodeURIComponent(valid)}` },
    }));
    assert.equal(getHop.status, 307);
    assert.equal(getHop.headers.get('location'), 'http://dashboard.test/');
    assert.match(getHop.headers.get('set-cookie') ?? '', /^hermes-session=/);
    assert.equal(requestCount(), 1);
  });
});

test('query-string tokens are ignored', async () => {
  await withJwks([trustedJwk], async (issuer) => {
    configureIssuer(issuer);
    const valid = await signedToken(issuer);
    const response = await GET(request(
      `http://dashboard.test/api/auth/sso?token=${encodeURIComponent(valid)}`,
    ));
    assert.equal(response.status, 401);
    assertSecurityHeaders(response);
    assert.deepEqual(await response.json(), { error: 'invalid_sso_token' });
  });
});
