import type { OAuthConfig, Scope } from './verifier.js';
export function protectedResource(config: OAuthConfig) {
  return { resource: config.resourceUrl, authorization_servers: [config.issuer], scopes_supported: ['cf.read', 'cf.submit'], bearer_methods_supported: ['header'] };
}
export function toolSecuritySchemes(scope: Scope) { return [{ type: 'oauth2', scopes: [scope] }]; }
export function addToolSecuritySchemes(response: unknown): unknown {
  if (!response || typeof response !== 'object') return response;
  const value = response as { result?: { tools?: Array<Record<string, unknown>> } };
  if (value.result?.tools) for (const tool of value.result.tools) {
    const meta = tool._meta as { securitySchemes?: unknown } | undefined;
    if (meta?.securitySchemes) tool.securitySchemes = meta.securitySchemes;
  }
  return response;
}
