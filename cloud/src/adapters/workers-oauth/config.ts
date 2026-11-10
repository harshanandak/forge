export interface OAuthConfig {
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  timeoutMs: number;
}

export function readOAuthConfig(
  _vars: Readonly<Record<string, unknown>>,
  _origin: string,
): OAuthConfig {
  throw new Error("OAuth configuration not implemented");
}
