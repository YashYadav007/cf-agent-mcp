import { createRemoteJWKSet, jwtVerify } from 'jose';

export type Scope = 'cf.read' | 'cf.submit';
export interface TokenClaims { subject: string; scopes: ReadonlySet<string> }
export interface TokenVerifier { verify(token: string): Promise<TokenClaims> }
export interface OAuthConfig { issuer: string; audience: string; jwksUrl: string; resourceUrl: string }
export class JwksTokenVerifier implements TokenVerifier {
  private readonly jwks;
  constructor(private readonly config: OAuthConfig) {
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5000, cooldownDuration: 30000 });
  }
  async verify(token: string): Promise<TokenClaims> {
    const { payload } = await jwtVerify(token, this.jwks, { issuer: this.config.issuer, audience: this.config.audience, requiredClaims: ['exp', 'sub'],
      algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'EdDSA'], clockTolerance: 30 });
    const scope = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
    const scp = Array.isArray(payload.scp) ? payload.scp.filter((item): item is string => typeof item === 'string') : [];
    return { subject: payload.sub ?? '', scopes: new Set([...scope, ...scp]) };
  }
}
export function hasScope(claims: TokenClaims, scope: Scope): boolean { return claims.scopes.has(scope); }
