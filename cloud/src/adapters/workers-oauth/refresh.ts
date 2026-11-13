import {
  OAuthAuthorizationServer,
  type Grant,
} from "@cloudflare/workers-oauth-provider";
import { grantHash, type OAuthOptions } from "./index.ts";
import { sha256 } from "../../tokens.ts";

export function refreshPolicy(
  options: OAuthOptions,
): NonNullable<OAuthOptions["refresh"]> {
  const oauth = new OAuthAuthorizationServer({
    issuer: options.issuer,
    resources: options.resources,
    clientIdMetadataDocumentEnabled: false,
  }).getOAuthApi({ OAUTH_KV: options.storage });
  const refuse = (error: string) =>
    Response.json(
      { error },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  return {
    async admit(form, authorization) {
      if (
        ["grant_type", "refresh_token", "client_id"].some(
          (key) => form.getAll(key).length !== 1 || !form.get(key),
        ) ||
        ["scope", "resource"].some((key) => form.getAll(key).length > 1) ||
        authorization ||
        ["client_secret", "client_assertion", "client_assertion_type"].some(
          (key) => form.has(key),
        )
      )
        return refuse("invalid_request");
      const token = String(form.get("refresh_token")),
        client = String(form.get("client_id"));
      if (
        (await oauth.lookupClient(client))?.tokenEndpointAuthMethod !== "none"
      )
        return refuse("invalid_client");
      const [user, id, secret, extra] = token.split(":"),
        hash = await grantHash(token, user ?? "");
      if (!user || !id || !secret || extra !== undefined || !hash)
        return refuse("invalid_grant");
      const grant = await options.storage.get<Grant>(`grant:${user}:${id}`, {
        type: "json",
      });
      const now = options.clock.now(),
        deadline = (grant?.expiresAt ?? NaN) * 1000;
      if (
        !grant ||
        grant.userId !== user ||
        grant.id !== id ||
        grant.clientId !== client ||
        !Number.isFinite(now) ||
        !Number.isSafeInteger(deadline) ||
        deadline - now < 60000
      )
        return refuse("invalid_grant");
      const resources =
        grant.resource === undefined
          ? options.resources
          : typeof grant.resource === "string"
            ? [grant.resource]
            : [];
      const resource = form.get("resource");
      const scope = form.get("scope");
      const scopes =
        typeof scope === "string" ? scope.split(" ").filter(Boolean) : [];
      if (
        resources.length !== 1 ||
        !options.resources.includes(resources[0]!) ||
        (form.has("resource")
          ? !resources.includes(String(resource)) ||
            !options.resources.includes(String(resource))
          : resources.length !== 1) ||
        (scopes.length > 0 &&
          !scopes.some((scope) => grant.scope.includes(scope)))
      )
        return refuse("invalid_grant");
      const providerHash = await sha256(token),
        tokenHash = await sha256(`forge:refresh:1:${token}`),
        clientHash = await sha256(client);
      if (!options.grantRevocation.claim)
        throw new Error("Refresh authority unavailable");
      const result = await options.grantRevocation.claim(
        hash,
        tokenHash,
        clientHash,
        deadline,
        grant.refreshTokenId === providerHash,
      );
      if (result !== "won") return refuse("invalid_grant");
      return undefined;
    },
    valid(value, user) {
      if (!value || typeof value !== "object") return false;
      const props = value as Record<string, unknown>,
        now = options.clock.now();
      return (
        typeof props.issuer === "string" &&
        !!props.issuer &&
        typeof props.subject === "string" &&
        !!props.subject &&
        typeof props.audience === "string" &&
        props.audience === props.verifiedAudience &&
        typeof props.expiresAt === "number" &&
        Number.isFinite(props.expiresAt) &&
        typeof props.authenticatedAt === "number" &&
        Number.isFinite(props.authenticatedAt) &&
        Number.isFinite(now) &&
        now >= props.authenticatedAt &&
        now < props.expiresAt &&
        user ===
          encodeURIComponent(JSON.stringify([props.issuer, props.subject]))
      );
    },
  };
}
