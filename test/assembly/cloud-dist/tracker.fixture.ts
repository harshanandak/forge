import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { durableStore } from "../../../cloud/src/store.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import {
  actor,
  ns,
  project,
} from "../../cloud/import-current-state.fixture.ts";
import { testIdentityVerifier } from "../../contract/lib/identity-verifier.ts";
import { cloudRig, type CloudRig, type Seen } from "./fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const origin = "https://fixture.example";
const issuer = "https://clerk.example";
const ip = "203.0.113.1";

async function approve(
  fetch: (request: Request) => Promise<Response>,
  code: string,
) {
  const send = (path: string, cookie = "", form?: Record<string, string>) =>
    fetch(
      new Request(origin + path, {
        method: form === undefined ? "GET" : "POST",
        headers: { Origin: origin, Cookie: cookie, "CF-Connecting-IP": ip },
        ...(form === undefined ? {} : { body: new URLSearchParams(form) }),
      }),
    );
  const start = await send("/device");
  assert.equal(start.status, 200);
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const csrf = cookie.slice(cookie.indexOf("=") + 1);
  const preview = await send("/device", cookie, { csrf, code });
  assert.equal(preview.status, 200);
  const page = await preview.text();
  const field = (name: string) =>
    new RegExp(`name="${name}" value="([^"]+)"`).exec(page)![1]!;
  const decision = await send("/device/approve", cookie, {
    csrf,
    confirm: "yes",
    ticket: field("ticket"),
    challenge: field("challenge"),
  });
  assert.equal(decision.status, 302);
  const state = new URL(decision.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const callback = await send(
    `/callback?${new URLSearchParams({ state, code: "owner" })}`,
    decision.headers.get("set-cookie")!.split(";")[0],
  );
  assert.equal(callback.status, 200);
  assert.ok((await callback.text()).includes(">approved</code>"));
}

/** Only the HTTPS boundary is adapted; Project.fetch owns tokens, receipts and leases. */
export async function trackerRig(
  bin: string,
  {
    devices = ["laptop", "desktop", "third", "fresh-checkout"],
    guardProjectOwner = false,
  } = {},
) {
  let unavailable = false;
  const redeemed = new Set<string>();
  const authority = await project(
    undefined,
    {
      FORGE_CLOUD_PROJECT: "proj",
      FORGE_CLOUD_ID_PREFIX: "forge",
      DEVICE_LOGIN_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url"),
      CLERK_ISSUER: issuer,
      FORGE_OWNER_SUBJECT: "owner",
      CLERK_CLIENT_ID: "client",
      CLERK_REDIRECT_URI: `${origin}/callback`,
    },
    () => {
      if (unavailable) throw new Error("synthetic storage outage");
    },
    {
      upstream: {
        begin: (state) =>
          Promise.resolve(
            `${issuer}/authorize?${new URLSearchParams({ state })}`,
          ),
        verify: (request, now) =>
          testIdentityVerifier(
            new Map([
              [
                "owner",
                {
                  issuer,
                  subject: "owner",
                  audience: "client",
                  authenticatedAt: now,
                  expiresAt: now + 60_000,
                },
              ],
            ]),
          ).verify(
            new URL(request.url).searchParams.get("code"),
            "client",
            now,
          ),
      },
      redemption: {
        claimOnce(hash) {
          if (redeemed.has(hash)) return Promise.resolve(false);
          redeemed.add(hash);
          return Promise.resolve(true);
        },
      },
    },
  );
  const clients: CloudRig[] = [];
  const responses: { status: number; body: unknown }[] = [];
  const ids: string[] = [];
  const forward = async (seen: Seen) => {
    const response = await authority.p.fetch(
      new Request(`${origin}${seen.url}`, {
        method: seen.method ?? "POST",
        headers: {
          authorization: seen.authorization ?? "",
          "content-type": "application/json",
          "CF-Connecting-IP": ip,
        },
        ...(seen.body === undefined ? {} : { body: JSON.stringify(seen.body) }),
      }),
    );
    const answer = { status: response.status, body: await response.json() };
    if (seen.url?.endsWith("/loginstart") && response.ok) {
      await approve(
        (request) => authority.p.fetch(request),
        (answer.body as { user_code: string }).user_code,
      );
    } else if (seen.url?.endsWith("/command")) responses.push(answer);
    return answer;
  };
  const close = async () => {
    try {
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      authority.close();
    }
  };
  try {
    const seeded = await authority.send("devices", {
      device: "seed",
      ttlMs: 86_400_000,
    });
    assert.equal(seeded.r.ok, true);
    const setup = guardProjectOwner ? "guarded" : "bound";
    for (const [index, device] of devices.entries()) {
      const session = `installed-${index}`;
      clients.push(await cloudRig(bin, forward, setup, { device, session }));
    }
    const logins = await Promise.all(
      clients.map((client) =>
        client.run([
          "auth",
          "login",
          "--bind-session",
          "--origin",
          client.origin,
          "--project",
          "proj",
        ]),
      ),
    );
    for (const [index, login] of logins.entries()) {
      const client = clients[index]!;
      if (!login.envelope.ok) throw new Error(login.envelope.error.code);
      client.expectUntouched(login);
      const result = login.envelope.result as {
        session: string;
        tokenId: string;
      };
      assert.equal(result.session, client.env.FORGE_SESSION);
      ids.push(result.tokenId);
    }
    return {
      clients,
      responses,
      seedLaneControl() {
        new StateOwner(durableStore(authority.storage), { now: Date.now }).put(
          ns,
          "lane-control:global",
          {
            version: 1,
            incarnation: "installed-dispatch",
            epoch: 0,
            resumeAllEpoch: 0,
            stopAll: null,
          },
          actor,
          { expectRevision: 0 },
        );
      },
      dispatchState() {
        return ["state_records", "state_events"].map((table) =>
          authority.db
            .query<{ key: string; body: string }, [string]>(
              `SELECT key, body FROM ${table} WHERE namespace=? AND key LIKE 'lane-dispatch:%' ORDER BY key`,
            )
            .all(ns)
            .map(({ key, body }) => ({
              key,
              body: JSON.parse(body) as unknown,
            })),
        );
      },
      outage(value: boolean) {
        unavailable = value;
      },
      async revoke(index: number) {
        const revoked = await authority.send("revoke", { id: ids[index] });
        assert.equal(revoked.r.ok, true);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
