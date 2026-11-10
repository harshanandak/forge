export class OAuthConfigError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super("OAuth configuration unavailable");
    this.variable = variable;
  }
}

export function readOAuthConfig(
  vars: Readonly<Record<string, unknown>>,
  origin: string,
) {
  const read = (name: string, valid: (value: string) => boolean) => {
    const value = vars[name];
    if (typeof value !== "string" || !valid(value))
      throw new OAuthConfigError(name);
    return value;
  };
  const https = (value: string) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !(url.username || url.password || url.search || url.hash) &&
        !/[\s\\]/.test(value)
      );
    } catch {
      return false;
    }
  };
  const issuer = read(
    "CLERK_ISSUER",
    (value) =>
      https(value) &&
      [new URL(value).origin, `${new URL(value).origin}/`].includes(value),
  );
  const clientId = read("CLERK_CLIENT_ID", (value) =>
    /^[\x21-\x7e]{1,256}$/.test(value),
  );
  const ownerSubject =
    vars.FORGE_OWNER_SUBJECT === undefined
      ? undefined
      : read(
          "FORGE_OWNER_SUBJECT",
          (value) => /^user_[A-Za-z0-9]+$/.test(value) && !/\s/.test(value),
        );
  const redirectUri = read(
    "CLERK_REDIRECT_URI",
    (value) => https(value) && value === `${origin}/callback`,
  );
  const resource = read("FORGE_API_RESOURCE", https);
  const timeoutMs = Number(
    read(
      "OAUTH_TIMEOUT_MS",
      (value) => /^[1-9]\d*$/.test(value) && Number(value) <= 2_147_483_647,
    ),
  );
  return {
    issuer,
    ...(ownerSubject === undefined ? {} : { ownerSubject }),
    authorizationUrl: new URL("/oauth/authorize", issuer).href,
    tokenUrl: new URL("/oauth/token", issuer).href,
    jwksUrl: new URL("/.well-known/jwks.json", issuer).href,
    clientId,
    redirectUri,
    resource,
    timeoutMs,
  };
}
