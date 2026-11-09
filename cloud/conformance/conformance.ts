// Conformance checks for the claim server, run against `wrangler dev` (see .github/workflows/cloud.yml).
// Phase "main" runs every check and saves what must survive a restart; phase "restart" reads it back.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Holder {
  readonly actor: { readonly kind: "agent"; readonly id: string };
  readonly session: {
    readonly id: string;
    readonly device: string;
    readonly agent: string;
    readonly harness: string;
  };
}
interface Lease {
  readonly subject: string;
  readonly holder: Holder;
  readonly generation: number;
  readonly expiresAt: string;
  readonly releasedAt?: string;
}
interface Reply {
  readonly status: number;
  readonly body: {
    readonly ok: boolean;
    readonly value?: Lease | null;
    readonly error?: {
      readonly code: string;
      readonly message: string;
      readonly lease?: Partial<Lease>;
    };
  };
}

const base = process.env.CLOUD_BASE ?? "http://127.0.0.1:8787";
const stateFile =
  process.env.CONFORMANCE_STATE ??
  join(tmpdir(), "forge-cloud-conformance.json");
const phase = process.argv[2] ?? "main";
const run = `c${Date.now()}`;
// The admin token comes from a file for live runs, so it never appears on a command line.
const adminToken = process.env.CLOUD_ADMIN_TOKEN_FILE
  ? readFileSync(process.env.CLOUD_ADMIN_TOKEN_FILE, "utf8").trim()
  : (process.env.CLOUD_ADMIN_TOKEN ?? "");
// Live runs hit the deployed Worker, which has no fault switch.
const live = process.env.CLOUD_LIVE === "1";

interface Device {
  readonly id: string;
  readonly token: string;
  readonly device: string;
  readonly session: string;
  readonly agent: string;
  readonly harness: string;
  readonly expiresAt: string;
}
interface AdminReply {
  readonly status: number;
  readonly body: {
    readonly ok: boolean;
    readonly value?: Device;
    readonly error?: { readonly code: string; readonly message: string };
  };
}

// Admin calls name the token they use. Device calls use the project's own device token unless the
// caller passes an `authorization` header ("" sends none).
async function admin(
  project: string,
  route: "devices" | "revoke",
  payload: object,
  token = adminToken,
): Promise<AdminReply> {
  const response = await fetch(`${base}/p/${project}/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: response.status,
    body: (await response.json()) as AdminReply["body"],
  };
}
async function issue(
  project: string,
  device: string,
  ttlMs = 3_600_000,
): Promise<Device> {
  const reply = await admin(project, "devices", {
    device,
    session: `session-${device}`,
    agent: `agent-${device}`,
    harness: "conformance",
    ttlMs,
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.value!;
}
// Admin read: whether the project has a database yet. It never creates one.
async function initialized(project: string): Promise<boolean> {
  const response = await fetch(`${base}/p/${project}/status`, {
    headers: { authorization: `Bearer ${adminToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as {
    value?: { initialized: boolean };
  };
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.value!.initialized;
}
interface Dump {
  readonly format: string;
  readonly tables: Record<string, readonly Record<string, unknown>[]>;
}
interface AdminBody {
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}
async function adminCall(
  project: string,
  method: "GET" | "POST",
  route: "dump" | "restore",
  body?: string,
  token = adminToken,
): Promise<{ status: number; body: AdminBody }> {
  const response = await fetch(`${base}/p/${project}/${route}`, {
    method,
    headers: token === "" ? {} : { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(60_000),
  });
  return {
    status: response.status,
    body: (await response.json()) as AdminBody,
  };
}
async function dumpOf(project: string): Promise<Dump> {
  const reply = await adminCall(project, "GET", "dump");
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.value as Dump;
}
const projectTokens = new Map<string, Promise<string>>();
const tokenFor = (project: string): Promise<string> => {
  let token = projectTokens.get(project);
  if (token === undefined) {
    token = issue(project, "device-default").then((device) => device.token);
    projectTokens.set(project, token);
  }
  return token;
};
const asDevice = (device: Device): Record<string, string> => ({
  authorization: `Bearer ${device.token}`,
});

async function send(
  project: string,
  method: "GET" | "POST",
  route: string,
  payload?: string | object,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const auth =
    "authorization" in headers
      ? headers
      : { ...headers, authorization: `Bearer ${await tokenFor(project)}` };
  const response = await fetch(`${base}/p/${project}/${route}`, {
    method,
    headers: {
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...Object.fromEntries(
        Object.entries(auth).filter(([, value]) => value !== ""),
      ),
    },
    ...(payload === undefined
      ? {}
      : {
          body: typeof payload === "string" ? payload : JSON.stringify(payload),
        }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Reply["body"] };
  } catch {
    throw new Error(
      `HTTP ${response.status} was not JSON: ${text.slice(0, 300)}`,
    );
  }
}

const holderOf = (name: string, index = 0): Holder => ({
  actor: { kind: "agent", id: `agent-${name}` },
  session: {
    id: `session-${name}-${index}`,
    device: "device-default",
    agent: `agent-${name}`,
    harness: "conformance",
  },
});
const onDevice = (holder: Holder, device: string): Holder => ({
  ...holder,
  session: { ...holder.session, device },
});
const claim = (
  project: string,
  subject: string,
  holder: Holder,
  requestId: string,
  ttlMs = 600_000,
): Promise<Reply> =>
  send(project, "POST", "claim", { subject, holder, ttlMs, requestId });
const holderLookup = (project: string, subject: string): Promise<Reply> =>
  send(project, "GET", `holder?subject=${encodeURIComponent(subject)}`);

function granted(reply: Reply): Lease {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  assert.ok(reply.body.value, "a grant carries the lease");
  return reply.body.value;
}
function refused(
  reply: Reply,
  code: string,
): NonNullable<Reply["body"]["error"]> {
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.ok, false, JSON.stringify(reply.body));
  assert.equal(reply.body.error?.code, code, JSON.stringify(reply.body));
  return reply.body.error;
}
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function skip(name: string, _body: () => Promise<void>): Promise<void> {
  console.log(`SKIP ${name}`);
  return Promise.resolve();
}
const failures: string[] = [];
async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(
      `FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const lookup = (
  project: string,
  subject: string,
  headers: Record<string, string>,
): Promise<Reply> =>
  send(
    project,
    "GET",
    `holder?subject=${encodeURIComponent(subject)}`,
    undefined,
    headers,
  );

let revokedPhone: Device | undefined;
const revokeCheck = (): Promise<void> =>
  check("a revoked token is refused on its next request", async () => {
    const project = `${run}-revoke`;
    const phone = await issue(project, "phone");
    revokedPhone = phone;
    const laptop = await issue(project, "laptop");
    const holder = holderOf("revoke");
    const attempt = (subject: string, device: Device): Promise<Reply> =>
      send(
        project,
        "POST",
        "claim",
        {
          subject,
          holder: onDevice(holder, device.device),
          ttlMs: 600_000,
          requestId: `claim-${subject}`,
        },
        asDevice(device),
      );
    const first = granted(await attempt("issue:revoke-1", phone));
    const revoked = await admin(project, "revoke", { id: phone.id });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

    // The next request with the revoked token is refused, naming the holder.
    for (const reply of [
      await lookup(project, "issue:revoke-1", asDevice(phone)),
      await attempt("issue:revoke-2", phone),
    ]) {
      assert.equal(reply.status, 401, JSON.stringify(reply.body));
      assert.equal(reply.body.error?.code, "AUTH_REVOKED");
      for (const part of [
        phone.device,
        phone.session,
        phone.agent,
        phone.harness,
        phone.expiresAt,
      ])
        assert.ok(reply.body.error?.message.includes(part), `names ${part}`);
    }
    // The refused claim granted nothing, and the other device still works.
    const none = await lookup(project, "issue:revoke-2", asDevice(laptop));
    assert.equal(none.body.value ?? null, null);
    assert.deepEqual(
      granted(await lookup(project, "issue:revoke-1", asDevice(laptop))),
      first,
    );
  });

if (phase === "revoke") await revokeCheck();

// Claim latency from this machine: 200 claims in a row, in milliseconds.
if (phase === "latency") {
  const project = `${run}-latency`;
  await tokenFor(project);
  const times: number[] = [];
  for (let i = 0; i < 200; i += 1) {
    const started = performance.now();
    granted(
      await claim(project, `issue:lat-${i}`, holderOf("lat"), `lat-${i}`),
    );
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const at = (q: number): string =>
    times[Math.ceil(q * times.length) - 1]!.toFixed(1);
  console.log(
    `claims=${times.length} p50=${at(0.5)}ms p95=${at(0.95)}ms max=${times.at(-1)!.toFixed(1)}ms`,
  );
}

if (phase === "main") {
  await revokeCheck();
  // The deployed Worker has no fault switch, so live runs skip that one case.
  const faulty = live ? skip : check;

  await check(
    "no token, a wrong token, or a device token on an admin route is refused before any state is read",
    async () => {
      const project = `${run}-auth`;
      const device = await issue(project, "tablet");
      const body = {
        subject: "issue:auth-1",
        holder: onDevice(holderOf("auth"), "tablet"),
        ttlMs: 600_000,
        requestId: "auth-1",
      };
      const [id, secret] = device.token.split(".") as [string, string];
      const wrong = `${id}.${"A".repeat(secret.length)}`;
      for (const [authorization, code] of [
        ["", "AUTH_REQUIRED"],
        [`Bearer ${wrong}`, "AUTH_INVALID"],
        ["Bearer not-a-token", "AUTH_INVALID"],
        [`Bearer fct_${"0".repeat(16)}.${secret}`, "AUTH_INVALID"],
      ] as const) {
        for (const reply of [
          await send(project, "POST", "claim", body, { authorization }),
          await lookup(project, "issue:auth-1", { authorization }),
        ]) {
          assert.equal(reply.status, 401, JSON.stringify(reply.body));
          assert.equal(reply.body.error?.code, code);
        }
      }
      const none = await lookup(project, "issue:auth-1", asDevice(device));
      assert.equal(
        none.body.value ?? null,
        null,
        "no refused claim took a lease",
      );
      for (const token of ["", device.token, wrong]) {
        const reply = await admin(
          project,
          "devices",
          { device: "x", ttlMs: 1_000 },
          token,
        );
        assert.equal(reply.status, 401, JSON.stringify(reply.body));
      }
      const revoke = await admin(
        project,
        "revoke",
        { id: device.id },
        device.token,
      );
      assert.equal(revoke.status, 401, JSON.stringify(revoke.body));
      granted(await send(project, "POST", "claim", body, asDevice(device)));
    },
  );

  await check("a device token claims only as its own device", async () => {
    const project = `${run}-device`;
    const tablet = await issue(project, "tablet");
    const claimAs = (named: object, requestId: string): Promise<Reply> =>
      send(
        project,
        "POST",
        "claim",
        { subject: "issue:device-1", holder: named, ttlMs: 600_000, requestId },
        asDevice(tablet),
      );
    const holder = holderOf("device");
    const reply = await claimAs(onDevice(holder, "phone"), "device-1");
    assert.equal(reply.status, 403, JSON.stringify(reply.body));
    assert.equal(reply.body.error?.code, "AUTH_DEVICE_MISMATCH");
    for (const part of ["tablet", "phone"])
      assert.ok(reply.body.error?.message.includes(part), `names ${part}`);
    const none = await lookup(project, "issue:device-1", asDevice(tablet));
    assert.equal(none.body.value ?? null, null, "the mismatch took no lease");
    // A holder with no device gets the token's device.
    const { device: _device, ...session } = holder.session;
    const lease = granted(await claimAs({ ...holder, session }, "device-2"));
    assert.equal(lease.holder.session.device, "tablet");
  });

  await check("an expired token is refused, naming the holder", async () => {
    const project = `${run}-expiry`;
    const device = await issue(project, "watch", 300);
    const before = await lookup(project, "issue:expiry-1", asDevice(device));
    assert.equal(before.status, 200, JSON.stringify(before.body));
    await sleep(600);
    const reply = await lookup(project, "issue:expiry-1", asDevice(device));
    assert.equal(reply.status, 401, JSON.stringify(reply.body));
    assert.equal(reply.body.error?.code, "AUTH_EXPIRED");
    for (const part of [device.device, device.agent, device.expiresAt])
      assert.ok(reply.body.error?.message.includes(part), `names ${part}`);
  });

  await check(
    "100 concurrent claims: 1 grant, 99 refusals naming the holder",
    async () => {
      const project = `${run}-race`;
      const replies = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          claim(project, "issue:work-1", holderOf("race", i), `race-${i}`),
        ),
      );
      const grants = replies.filter((reply) => reply.status === 200);
      assert.equal(grants.length, 1, `${grants.length} grants`);
      const winner = granted(grants[0]!);
      const losers = replies.filter((reply) => reply.status !== 200);
      assert.equal(losers.length, 99);
      for (const reply of losers) {
        const error = refused(reply, "LEASE_HELD");
        assert.deepEqual(error.lease?.holder, winner.holder);
        assert.equal(error.lease?.generation, winner.generation);
        assert.equal(error.lease?.expiresAt, winner.expiresAt);
        for (const part of [
          winner.holder.session.device,
          winner.holder.session.agent,
          winner.holder.session.harness,
          winner.holder.session.id,
          winner.expiresAt,
        ])
          assert.ok(error.message.includes(part), `message names ${part}`);
      }
      const lookup = granted(await holderLookup(project, "issue:work-1"));
      assert.deepEqual(lookup, winner);
    },
  );

  await check(
    "a retry with the same request id returns the same result, and changed input is refused",
    async () => {
      const project = `${run}-retry`;
      const holder = holderOf("retry");
      const subject = "issue:work-2";
      const first = granted(await claim(project, subject, holder, "claim-1"));
      assert.deepEqual(
        granted(await claim(project, subject, holder, "claim-1")),
        first,
      );
      refused(
        await claim(project, subject, holder, "claim-1", 1_000),
        "INPUT_CONFLICT",
      );

      const renewal = {
        subject,
        holder,
        generation: first.generation,
        ttlMs: 900_000,
        requestId: "renew-1",
      };
      const renewed = granted(await send(project, "POST", "renew", renewal));
      assert.notEqual(renewed.expiresAt, first.expiresAt);
      await sleep(50);
      assert.deepEqual(
        granted(await send(project, "POST", "renew", renewal)),
        renewed,
      );
      refused(
        await send(project, "POST", "renew", { ...renewal, ttlMs: 1_000 }),
        "INPUT_CONFLICT",
      );

      const release = {
        subject,
        holder,
        generation: first.generation,
        requestId: "release-1",
      };
      const released = granted(await send(project, "POST", "release", release));
      assert.ok(released.releasedAt, "the release is recorded");
      assert.deepEqual(
        granted(await send(project, "POST", "release", release)),
        released,
      );
      assert.deepEqual(granted(await holderLookup(project, subject)), released);
    },
  );

  await faulty(
    "a failed receipt insert rolls the mutation back, and a retry gives the correct result",
    async () => {
      const project = `${run}-atomic`;
      const subject = "issue:work-12";
      const holder = holderOf("atomic");
      const fault = { "x-cloud-fault": "receipt-insert" };
      const failedClaim = await send(
        project,
        "POST",
        "claim",
        { subject, holder, ttlMs: 600_000, requestId: "atomic-claim" },
        fault,
      );
      assert.equal(failedClaim.status, 500, JSON.stringify(failedClaim.body));
      assert.equal(failedClaim.body.error?.code, "INTERNAL");
      assert.equal(
        (await holderLookup(project, subject)).body.value ?? null,
        null,
        "a failed claim leaves no lease",
      );
      const first = granted(
        await claim(project, subject, holder, "atomic-claim"),
      );

      const renewal = {
        subject,
        holder,
        generation: first.generation,
        ttlMs: 900_000,
        requestId: "atomic-renew",
      };
      const failedRenew = await send(project, "POST", "renew", renewal, fault);
      assert.equal(failedRenew.status, 500, JSON.stringify(failedRenew.body));
      assert.deepEqual(
        granted(await holderLookup(project, subject)),
        first,
        "a failed renew leaves the lease as it was",
      );
      await sleep(50);
      const renewed = granted(await send(project, "POST", "renew", renewal));
      assert.notEqual(renewed.expiresAt, first.expiresAt);
      assert.deepEqual(granted(await holderLookup(project, subject)), renewed);
      assert.deepEqual(
        granted(await send(project, "POST", "renew", renewal)),
        renewed,
        "the retry is now recorded and replays the current lease",
      );
    },
  );

  await check(
    "a replayed renew is refused once the next generation exists; a replayed release returns its released result",
    async () => {
      const project = `${run}-superseded`;
      const subject = "issue:work-7";
      const a = holderOf("a");
      const first = granted(await claim(project, subject, a, "a-claim"));
      const renewal = {
        subject,
        holder: a,
        generation: first.generation,
        ttlMs: 900_000,
        requestId: "a-renew",
      };
      granted(await send(project, "POST", "renew", renewal));
      const release = {
        subject,
        holder: a,
        generation: first.generation,
        requestId: "a-release",
      };
      const released = granted(await send(project, "POST", "release", release));
      const next = granted(
        await claim(project, subject, holderOf("b"), "b-claim"),
      );
      assert.equal(next.generation, first.generation + 1);
      refused(await send(project, "POST", "renew", renewal), "LEASE_STALE");
      assert.deepEqual(
        granted(await send(project, "POST", "release", release)),
        released,
      );
      assert.deepEqual(granted(await holderLookup(project, subject)), next);
    },
  );

  await check(
    "one request id serves one route and one input across claim, renew and release",
    async () => {
      const project = `${run}-shared`;
      const holder = holderOf("shared");
      const held = granted(
        await claim(project, "issue:work-8", holder, "shared-1"),
      );
      refused(
        await send(project, "POST", "release", {
          subject: "issue:work-8",
          holder,
          generation: held.generation,
          requestId: "shared-1",
        }),
        "INPUT_CONFLICT",
      );
      assert.deepEqual(
        granted(await holderLookup(project, "issue:work-8")),
        held,
      );
      granted(
        await send(project, "POST", "renew", {
          subject: "issue:work-8",
          holder,
          generation: held.generation,
          ttlMs: 900_000,
          requestId: "shared-2",
        }),
      );
      refused(
        await claim(project, "issue:work-9", holder, "shared-2"),
        "INPUT_CONFLICT",
      );
      assert.equal(
        (await holderLookup(project, "issue:work-9")).body.value ?? null,
        null,
      );
    },
  );

  await check(
    "a retry with the same values in another key order is the same request",
    async () => {
      const project = `${run}-order`;
      const subject = "issue:work-10";
      const holder = holderOf("order");
      const first = granted(
        await claim(project, subject, holder, "order-claim"),
      );
      const { actor, session } = holder;
      const reordered = `{"session":{"harness":${JSON.stringify(session.harness)},"agent":${JSON.stringify(session.agent)},"device":${JSON.stringify(session.device)},"id":${JSON.stringify(session.id)}},"actor":{"id":${JSON.stringify(actor.id)},"kind":"agent"}}`;
      const renewal = `{"requestId":"order-renew","ttlMs":900000,"generation":${first.generation},"subject":"${subject}","holder":${reordered}}`;
      const renewed = granted(
        await send(project, "POST", "renew", {
          subject,
          holder,
          generation: first.generation,
          ttlMs: 900_000,
          requestId: "order-renew",
        }),
      );
      await sleep(50);
      assert.deepEqual(
        granted(await send(project, "POST", "renew", renewal)),
        renewed,
      );
      const again = `{"holder":${reordered},"ttlMs":600000,"subject":"${subject}","requestId":"order-claim"}`;
      assert.deepEqual(
        granted(await send(project, "POST", "claim", again)),
        renewed,
      );
    },
  );

  await check(
    "a replay returns the current lease, never an old expiry",
    async () => {
      const project = `${run}-current`;
      const subject = "issue:work-11";
      const holder = holderOf("current");
      const long = granted(await claim(project, subject, holder, "long-grant"));
      const renewal = (ttlMs: number, requestId: string) => ({
        subject,
        holder,
        generation: long.generation,
        ttlMs,
        requestId,
      });
      const longer = granted(
        await send(project, "POST", "renew", renewal(900_000, "renew-a")),
      );
      const short = granted(
        await send(project, "POST", "renew", renewal(1_000, "renew-b")),
      );
      assert.notEqual(short.expiresAt, longer.expiresAt);
      for (const replay of [
        send(project, "POST", "renew", renewal(900_000, "renew-a")),
        claim(project, subject, holder, "long-grant"),
      ])
        assert.deepEqual(granted(await replay), short);
      await sleep(1_300);
      refused(
        await send(project, "POST", "renew", renewal(900_000, "renew-a")),
        "LEASE_STALE",
      );
      refused(
        await claim(project, subject, holder, "long-grant"),
        "LEASE_STALE",
      );
    },
  );

  await check(
    "a refused request keeps its id: another input conflicts and a retry stays refused",
    async () => {
      const project = `${run}-refused`;
      const owner = holderOf("owner");
      const rival = holderOf("rival");
      const held = granted(
        await claim(project, "issue:work-12", owner, "owner-claim"),
      );
      refused(
        await claim(project, "issue:work-12", rival, "rival-1"),
        "LEASE_HELD",
      );
      refused(
        await claim(project, "issue:work-13", rival, "rival-1"),
        "INPUT_CONFLICT",
      );
      assert.equal(
        (await holderLookup(project, "issue:work-13")).body.value ?? null,
        null,
      );
      granted(
        await send(project, "POST", "release", {
          subject: "issue:work-12",
          holder: owner,
          generation: held.generation,
          requestId: "owner-release",
        }),
      );
      const again = refused(
        await claim(project, "issue:work-12", rival, "rival-1"),
        "LEASE_HELD",
      );
      assert.deepEqual(again.lease?.holder, owner);
      assert.ok(
        (await holderLookup(project, "issue:work-12")).body.value?.releasedAt,
        "the retry did not take the lease",
      );
      granted(await claim(project, "issue:work-12", rival, "rival-2"));
    },
  );

  await check(
    "a refused renew or release keeps its id: the retry stays refused and another route or input conflicts",
    async () => {
      const project = `${run}-refused-write`;
      const subject = "issue:work-14";
      const a = holderOf("a");
      const b = holderOf("b");
      const held = granted(await claim(project, subject, a, "a-claim"));
      const renew = {
        subject,
        holder: b,
        generation: held.generation,
        ttlMs: 60_000,
        requestId: "b-renew",
      };
      const release = {
        subject,
        holder: b,
        generation: held.generation,
        requestId: "b-release",
      };
      refused(await send(project, "POST", "renew", renew), "LEASE_NOT_HELD");
      refused(
        await send(project, "POST", "release", release),
        "LEASE_NOT_HELD",
      );
      granted(
        await send(project, "POST", "release", {
          subject,
          holder: a,
          generation: held.generation,
          requestId: "a-release",
        }),
      );
      granted(await claim(project, subject, b, "b-claim"));
      // Run again, each would now be LEASE_STALE; the recorded refusal comes back instead.
      refused(await send(project, "POST", "renew", renew), "LEASE_NOT_HELD");
      refused(
        await send(project, "POST", "release", release),
        "LEASE_NOT_HELD",
      );
      refused(
        await send(project, "POST", "release", {
          ...release,
          requestId: "b-renew",
        }),
        "INPUT_CONFLICT",
      );
      refused(
        await send(project, "POST", "renew", { ...renew, ttlMs: 1_000 }),
        "INPUT_CONFLICT",
      );
      refused(
        await send(project, "POST", "release", {
          ...release,
          generation: held.generation + 1,
        }),
        "INPUT_CONFLICT",
      );
    },
  );

  await check(
    "expiry and fencing: stale renew, release and claim replay are refused",
    async () => {
      const project = `${run}-fence`;
      const subject = "issue:work-3";
      const old = holderOf("old");
      const oldClaim = granted(
        await claim(project, subject, old, "old-grant", 80),
      );
      await sleep(160);
      const lapsed = {
        subject,
        holder: old,
        generation: oldClaim.generation,
        ttlMs: 60_000,
      };
      refused(
        await send(project, "POST", "renew", {
          ...lapsed,
          requestId: "lapsed-renew",
        }),
        "LEASE_EXPIRED",
      );
      const successor = holderOf("new");
      const next = granted(
        await claim(project, subject, successor, "new-grant"),
      );
      assert.equal(next.generation, oldClaim.generation + 1);
      refused(
        await send(project, "POST", "renew", {
          ...lapsed,
          requestId: "stale-renew",
        }),
        "LEASE_STALE",
      );
      refused(
        await send(project, "POST", "release", {
          subject,
          holder: old,
          generation: oldClaim.generation,
          requestId: "stale-release",
        }),
        "LEASE_STALE",
      );
      refused(
        await claim(project, subject, old, "old-grant", 80),
        "LEASE_STALE",
      );
      assert.deepEqual(granted(await holderLookup(project, subject)), next);
    },
  );

  await check(
    "a request outside the contract is refused, not guessed",
    async () => {
      const project = `${run}-input`;
      const holder = holderOf("input");
      const unsafe = await send(
        project,
        "POST",
        "claim",
        `{"subject":"issue:work-4","holder":${JSON.stringify(holder)},"ttlMs":9007199254740993,"requestId":"unsafe-1"}`,
      );
      assert.equal(unsafe.status, 400, JSON.stringify(unsafe.body));
      assert.equal(unsafe.body.error?.code, "INPUT_INVALID");
      const noId = await send(project, "POST", "claim", {
        subject: "issue:work-4",
        holder,
        ttlMs: 1_000,
      });
      assert.equal(noId.status, 400, JSON.stringify(noId.body));
      assert.equal(noId.body.error?.code, "INPUT_INVALID");
      const route = await send(project, "GET", "nowhere");
      assert.equal(route.status, 404, JSON.stringify(route.body));
      assert.equal(
        (await holderLookup(project, "issue:work-4")).body.value ?? null,
        null,
      );
    },
  );

  await check(
    "a bad token creates no project database, and a token for another project is refused",
    async () => {
      const fresh = `${run}-never-seen`;
      const wrong = `fct_${"1".repeat(16)}.${"B".repeat(43)}`;
      for (const authorization of ["Bearer not-a-token", `Bearer ${wrong}`]) {
        const claimed = await send(
          fresh,
          "POST",
          "claim",
          {
            subject: "issue:never-1",
            holder: holderOf("never"),
            ttlMs: 600_000,
            requestId: "never-1",
          },
          { authorization },
        );
        assert.equal(claimed.status, 401, JSON.stringify(claimed.body));
        assert.equal(claimed.body.error?.code, "AUTH_INVALID");
        const read = await lookup(fresh, "issue:never-1", { authorization });
        assert.equal(read.status, 401, JSON.stringify(read.body));
      }
      assert.equal(await initialized(fresh), false, "no database was made");

      const a = await issue(`${run}-a`, "tablet");
      await issue(`${run}-b`, "tablet");
      for (const project of [`${run}-b`, fresh]) {
        const reply = await lookup(project, "issue:x-1", asDevice(a));
        assert.equal(reply.status, 401, JSON.stringify(reply.body));
        assert.equal(reply.body.error?.code, "AUTH_INVALID");
      }
      assert.equal(await initialized(fresh), false, "A's token made nothing");
      await issue(fresh, "tablet");
      assert.equal(await initialized(fresh), true, "a token issue makes it");
    },
  );

  await check(
    "a bad token is refused by its token, not by its body size; a good token with a big body is refused for size",
    async () => {
      const project = `${run}-big`;
      const device = await issue(project, "tablet");
      const big = JSON.stringify({ requestId: "x".repeat(1_000_000) });
      const bad = `Bearer fct_${"2".repeat(16)}.${"C".repeat(43)}`;
      const refusedBad = await send(project, "POST", "claim", big, {
        authorization: bad,
      });
      assert.equal(refusedBad.status, 401, JSON.stringify(refusedBad.body));
      assert.equal(refusedBad.body.error?.code, "AUTH_INVALID");
      const refusedBig = await send(
        project,
        "POST",
        "claim",
        big,
        asDevice(device),
      );
      assert.equal(refusedBig.status, 400, JSON.stringify(refusedBig.body));
      assert.equal(refusedBig.body.error?.code, "INPUT_INVALID");
    },
  );

  await check(
    "a project dumps to JSON without token hashes and restores into an empty project, read back identical",
    async () => {
      const source = `${run}-dump-a`;
      const target = `${run}-dump-b`;
      const holder = holderOf("dump");
      const first = granted(
        await claim(source, "issue:dump-1", holder, "dump-1"),
      );
      granted(
        await send(source, "POST", "renew", {
          subject: "issue:dump-1",
          holder,
          generation: first.generation,
          ttlMs: 900_000,
          requestId: "dump-renew",
        }),
      );
      refused(
        await claim(source, "issue:dump-1", holderOf("rival"), "dump-rival"),
        "LEASE_HELD",
      );
      granted(await claim(source, "issue:dump-2", holder, "dump-2"));
      const device = await issue(source, "tablet");

      const dump = await dumpOf(source);
      assert.equal(dump.format, "forge-cloud-dump/1");
      assert.deepEqual(Object.keys(dump.tables).sort(), [
        "domain_cloud_requests",
        "state_events",
        "state_leases",
        "state_records",
        "state_requests",
      ]);
      assert.equal(dump.tables.state_leases!.length, 2);
      assert.ok(dump.tables.domain_cloud_requests!.length >= 4, "receipts");
      const secret = device.token.split(".")[1]!;
      const digest = createHash("sha256").update(secret).digest("hex");
      const text = JSON.stringify(dump);
      for (const hidden of [
        secret,
        digest,
        device.token,
        "domain_cloud_tokens",
      ])
        assert.ok(!text.includes(hidden), "the dump holds no token or hash");

      const restored = await adminCall(target, "POST", "restore", text);
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      assert.deepEqual(await dumpOf(target), dump, "read back identical");
      // The restored project serves the same lease and replays the same receipts.
      assert.deepEqual(
        granted(await holderLookup(target, "issue:dump-1")),
        granted(await holderLookup(source, "issue:dump-1")),
      );
      assert.deepEqual(
        granted(await claim(target, "issue:dump-2", holder, "dump-2")),
        granted(await claim(source, "issue:dump-2", holder, "dump-2")),
      );

      // Restore goes only into an empty project and only with a clean document.
      const again = await adminCall(target, "POST", "restore", text);
      assert.equal(again.status, 409, JSON.stringify(again.body));
      assert.equal(again.body.error?.code, "RESTORE_TARGET_NOT_EMPTY");
      const bad = (name: string, document: string): Promise<void> =>
        adminCall(`${run}-${name}`, "POST", "restore", document).then(
          async (reply) => {
            assert.equal(reply.status, 400, JSON.stringify(reply.body));
            assert.equal(reply.body.error?.code, "INPUT_INVALID");
            assert.equal(await initialized(`${run}-${name}`), false);
          },
        );
      await bad(
        "dump-unsafe",
        text.replace(/"generation":\d+/, '"generation":9007199254740993'),
      );
      await bad("dump-column", text.replace('"subject"', '"subject2"'));
      await bad("dump-table", text.replace('"state_events"', '"state_other"'));

      // Only the admin token may dump or restore.
      for (const token of ["", device.token]) {
        assert.equal(
          (await adminCall(source, "GET", "dump", undefined, token)).status,
          401,
        );
        assert.equal(
          (await adminCall(`${run}-x`, "POST", "restore", text, token)).status,
          401,
        );
      }
    },
  );

  await check(
    "a restore with deep nesting or an extra top-level field is refused before anything is built",
    async () => {
      const head = '{"format":"forge-cloud-dump/1","tables":';
      const tables = [
        "state_records",
        "state_events",
        "state_leases",
        "state_requests",
        "domain_cloud_requests",
      ].map((table) => `"${table}":[]`);
      const documents = {
        "dump-deep": `${head}${"[".repeat(50_000)}${"]".repeat(50_000)}}`,
        "dump-extra": `${head}{${tables.join(",")}},"extra":1}`,
      };
      for (const [name, document] of Object.entries(documents)) {
        const reply = await adminCall(
          `${run}-${name}`,
          "POST",
          "restore",
          document,
        );
        assert.equal(reply.status, 400, JSON.stringify(reply.body));
        assert.equal(reply.body.error?.code, "INPUT_INVALID");
        assert.equal(await initialized(`${run}-${name}`), false);
        if (name === "dump-deep")
          assert.ok(reply.body.error?.message.includes("nests deeper"));
      }
    },
  );

  await check(
    "a restore over its size bound is refused as RESTORE_TOO_LARGE and creates nothing",
    async () => {
      const project = `${run}-restore-big`;
      const body = "x".repeat(9 * 1024 * 1024);
      const reply = await adminCall(project, "POST", "restore", body);
      assert.equal(reply.status, 413, JSON.stringify(reply.body));
      assert.equal(reply.body.error?.code, "RESTORE_TOO_LARGE");
      assert.equal(await initialized(project), false);
    },
  );

  const project = `${run}-persist`;
  const holder = holderOf("persist");
  const claimed = granted(
    await claim(project, "issue:work-5", holder, "persist-claim"),
  );
  const other = granted(
    await claim(
      project,
      "issue:work-6",
      holderOf("persist", 1),
      "persist-other",
    ),
  );
  const freed = granted(
    await send(project, "POST", "release", {
      subject: "issue:work-6",
      holder: holderOf("persist", 1),
      generation: other.generation,
      requestId: "persist-release",
    }),
  );
  writeFileSync(
    stateFile,
    JSON.stringify({ project, holder, claimed, freed, revoked: revokedPhone }),
  );
  console.log(`saved restart state for ${project}`);
} else if (phase === "restart") {
  const saved = JSON.parse(readFileSync(stateFile, "utf8")) as {
    project: string;
    holder: Holder;
    claimed: Lease;
    freed: Lease;
    revoked: Device;
  };
  await check("claims and request ids survive a restart", async () => {
    assert.deepEqual(
      granted(await holderLookup(saved.project, "issue:work-5")),
      saved.claimed,
    );
    assert.deepEqual(
      granted(await holderLookup(saved.project, "issue:work-6")),
      saved.freed,
    );
    assert.deepEqual(
      granted(
        await claim(
          saved.project,
          "issue:work-5",
          saved.holder,
          "persist-claim",
        ),
      ),
      saved.claimed,
    );
    refused(
      await claim(
        saved.project,
        "issue:work-5",
        holderOf("late"),
        "late-claim",
      ),
      "LEASE_HELD",
    );
    const free = granted(
      await claim(
        saved.project,
        "issue:work-6",
        holderOf("late"),
        "late-claim-2",
      ),
    );
    assert.equal(free.generation, saved.freed.generation + 1);
  });

  await check(
    "a revoked token is still refused after the restart",
    async () => {
      const project = saved.project.replace(/persist$/, "revoke");
      const reply = await lookup(
        project,
        "issue:revoke-1",
        asDevice(saved.revoked),
      );
      assert.equal(reply.status, 401, JSON.stringify(reply.body));
      assert.equal(reply.body.error?.code, "AUTH_REVOKED");
    },
  );
}

if (failures.length > 0) {
  console.log(`${failures.length} failed: ${failures.join("; ")}`);
  process.exitCode = 1;
}
