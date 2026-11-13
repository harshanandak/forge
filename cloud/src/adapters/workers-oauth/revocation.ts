import { grantHash, type OAuthAdapter, type OAuthOptions } from "./index.ts";
import { sha256 } from "../../tokens.ts";
import type { Grant } from "@cloudflare/workers-oauth-provider";

export async function revokeOAuth(
  request: Request,
  options: OAuthOptions,
  adapter: OAuthAdapter,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const reply = (error?: string, status = 400) =>
    error
      ? Response.json({ error }, { status, headers })
      : new Response(null, { headers });
  try {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (
      request.method !== "POST" ||
      contentType.split(";")[0]?.trim().toLowerCase() !==
        "application/x-www-form-urlencoded" ||
      request.headers.has("Authorization")
    )
      return reply("invalid_request");
    let form;
    try {
      form = await request.formData();
    } catch {
      return reply("invalid_request");
    }
    if (
      ["token", "client_id"].some(
        (key) =>
          form.getAll(key).length !== 1 ||
          typeof form.get(key) !== "string" ||
          !form.get(key),
      ) ||
      form.getAll("token_type_hint").length > 1 ||
      ["client_secret", "client_assertion", "client_assertion_type"].some(
        (key) => form.has(key),
      )
    )
      return reply("invalid_request");
    const token = form.get("token") as string,
      client = form.get("client_id") as string;
    if (!(await adapter.isPublicClient(client))) return reply("invalid_client");
    const refreshProof = async () => {
      const parts = token.split(":"),
        [user, id] = parts;
      if (parts.length !== 3 || parts.some((part) => !part)) return null;
      const grant = await options.storage.get<Grant>(`grant:${user}:${id}`, {
        type: "json",
      });
      const now = options.clock.now();
      if (
        !grant ||
        grant.userId !== user ||
        grant.id !== id ||
        grant.clientId !== client ||
        !Number.isFinite(now) ||
        !Number.isSafeInteger(grant.expiresAt! * 1000) ||
        now >= grant.expiresAt! * 1000
      )
        return null;
      const hash = await sha256(token);
      return [grant.refreshTokenId, grant.previousRefreshTokenId].includes(hash)
        ? grantHash(token, user)
        : null;
    };
    const accessProof = () => adapter.proveAccess(token, client);
    const proofs =
      form.get("token_type_hint") === "refresh_token"
        ? [refreshProof, accessProof]
        : [accessProof, refreshProof];
    const hash = (await proofs[0]!()) ?? (await proofs[1]!());
    if (hash) await options.grantRevocation.revoke(hash);
    return reply();
  } catch {
    return reply("temporarily_unavailable", 503);
  }
}
