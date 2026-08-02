import { createRemoteJWKSet, decodeJwt, jwtVerify, type RemoteJWKSet } from 'jose';

const DEFAULT_JWKS_TTL_MS = 10 * 60 * 1000;
const MAX_CLOCK_SKEW_SECONDS = 60;
const GENERIC_ERROR = 'Invalid StageSnap SSO token';

const jwksByIssuer = new Map<string, { ttl: number; jwks: RemoteJWKSet }>();

function configuredIssuers(): string[] {
  return (process.env.STAGESNAP_SSO_ISSUERS ?? '')
    .split(',')
    .map((issuer) => issuer.trim())
    .filter(Boolean);
}

function configuredTtl(): number {
  const value = Number(process.env.STAGESNAP_SSO_JWKS_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_JWKS_TTL_MS;
}

function getJwks(issuer: string): RemoteJWKSet {
  const ttl = configuredTtl();
  const cached = jwksByIssuer.get(issuer);
  if (cached?.ttl === ttl) return cached.jwks;

  const jwksUrl = new URL('/.well-known/jwks.json', issuer);
  const jwks = createRemoteJWKSet(jwksUrl, {
    cacheMaxAge: ttl,
    cooldownDuration: 0,
  });
  jwksByIssuer.set(issuer, { ttl, jwks });
  return jwks;
}

export async function verifyStagesnapToken(token: string): Promise<{ sub: string }> {
  try {
    if (!token) throw new Error(GENERIC_ERROR);

    const issuers = configuredIssuers();
    const unverifiedIssuer = decodeJwt(token).iss;
    if (typeof unverifiedIssuer !== 'string' || !issuers.includes(unverifiedIssuer)) {
      throw new Error(GENERIC_ERROR);
    }

    const audience = process.env.STAGESNAP_SSO_AUDIENCE?.trim();
    const { payload } = await jwtVerify(token, getJwks(unverifiedIssuer), {
      algorithms: ['RS256'],
      issuer: issuers,
      audience: audience || undefined,
      clockTolerance: MAX_CLOCK_SKEW_SECONDS,
      requiredClaims: ['iss', 'sub', 'exp'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new Error(GENERIC_ERROR);
    }
    return { sub: payload.sub };
  } catch {
    throw new Error(GENERIC_ERROR);
  }
}
