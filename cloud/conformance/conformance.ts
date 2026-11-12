// Conformance checks for the claim server, run against `wrangler dev` (see .github/workflows/cloud.yml).
// Phase "main" runs every check and saves what must survive a restart; phase "restart" reads it back.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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
  bound = true,
): Promise<Device> {
  const reply = await admin(project, "devices", {
    device,
    ...(bound ? { session: `session-${device}` } : {}),
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
  route: string,
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
// An admin restore that declares `length` bytes in Content-Length and sends none of them. The reply is
// read as soon as the Worker sends it, then the request is dropped.
function refusedBeforeUpload(
  project: string,
  length: number,
): Promise<{ status: number; body: AdminBody }> {
  const url = new URL(`${base}/p/${project}/restore`);
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const call = send(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-length": String(length),
        },
        timeout: 20_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as AdminBody,
          });
          call.destroy();
        });
        response.on("error", reject);
      },
    );
    call.on("timeout", () => call.destroy(new Error("no reply in 20 seconds")));
    call.on("error", reject);
    call.flushHeaders();
  });
}
async function dumpOf(project: string): Promise<Dump> {
  const reply = await adminCall(project, "GET", "dump");
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.value as Dump;
}
// One page of a paged dump (GET dump?cursor=start, then the cursor each page names as `next`).
interface DumpPage {
  readonly format: string;
  readonly page: number;
  readonly last: boolean;
  readonly next: string | null;
  readonly tables: Record<string, readonly Record<string, unknown>[]>;
}
async function pagesOf(project: string): Promise<DumpPage[]> {
  const pages: DumpPage[] = [];
  let cursor = "start";
  for (;;) {
    const reply = await adminCall(
      project,
      "GET",
      `dump?cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const page = reply.body.value as DumpPage;
    assert.equal(page.format, "forge-cloud-dump-page/1");
    pages.push(page);
    if (page.next === null) return pages;
    assert.ok(pages.length < 200, "the pages end");
    cursor = page.next;
  }
}
const sendPage = (
  project: string,
  page: unknown,
): ReturnType<typeof adminCall> =>
  adminCall(project, "POST", "restore", JSON.stringify(page));
const projectTokens = new Map<string, Promise<string>>();
const tokenFor = (project: string): Promise<string> => {
  let token = projectTokens.get(project);
  if (token === undefined) {
    // Sessionless: the shared token claims as any session, so only the device bounds it.
    token = issue(project, "device-default", undefined, false).then(
      (device) => device.token,
    );
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
// A session-bound token claims only as its own session.
const asSession = (holder: Holder, device: Device): Holder => ({
  ...holder,
  session: { ...holder.session, id: device.session },
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
// A holder lookup that succeeded and reports no lease. An error reply has no value either, so the
// status and the ok flag are checked first.
function noLease(reply: Reply): void {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  assert.equal(reply.body.value ?? null, null, JSON.stringify(reply.body));
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

// The typed /command route. The Worker admits one project (FORGE_CLOUD_PROJECT) and shows its issue ids with
// FORGE_CLOUD_ID_PREFIX, so every typed check runs there. A reply is an envelope: status OK with a result,
// or FAIL with an error code.
const typedProject = process.env.FORGE_CLOUD_PROJECT ?? "";
interface Envelope {
  readonly ok: boolean;
  readonly status?: "OK" | "FAIL";
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}
interface TypedReply {
  readonly status: number;
  readonly body: Envelope;
}
interface Item {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly dependsOn: readonly string[];
  readonly body?: string;
  readonly kind?: string;
  readonly labels: readonly string[];
  readonly lease?: {
    readonly generation: number;
    readonly holder: Holder;
    readonly expiresAt: string;
  };
}
interface Grant {
  readonly id: string;
  readonly generation: number;
  readonly expiresAt: string;
}
interface Call {
  readonly requestId: string;
  readonly op: string;
  readonly input: object;
  readonly context: object;
}
// A device token with the actor and session it acts as. A session-bound token must name its own
// session; a sessionless token names any.
interface Caller {
  readonly device: Device;
  readonly actor: Holder["actor"];
  readonly session: string;
}
interface TypedSaved {
  readonly caller: Caller;
  readonly create: Call;
  readonly created: Item;
  readonly latest: readonly Item[];
  readonly ready: readonly string[];
  readonly dump: Dump;
}

async function callerFor(name: string, bound = true): Promise<Caller> {
  const device = await issue(typedProject, `typed-${name}`, undefined, bound);
  return {
    device,
    actor: { kind: "agent", id: `agent-typed-${name}` },
    session: bound ? device.session : `session-chosen-${name}`,
  };
}
async function typedCall(
  who: Caller,
  call: Call,
  headers: Record<string, string> = {},
  project = typedProject,
): Promise<TypedReply> {
  const response = await fetch(`${base}/p/${project}/command`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${who.device.token}`,
      ...headers,
    },
    body: JSON.stringify(call),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Envelope };
  } catch {
    throw new Error(
      `HTTP ${response.status} was not JSON: ${text.slice(0, 300)}`,
    );
  }
}
const asProject = (who: Caller): object => ({ actor: who.actor });
const asClaimer = (who: Caller): object => ({
  actor: who.actor,
  session: { id: who.session },
});
const asHolder = (who: Caller, leaseGeneration: number): object => ({
  ...asClaimer(who),
  leaseGeneration,
});
const claimOf = (requestId: string, who: Caller, id: string): Call => ({
  requestId,
  op: "issue.claim",
  input: { id, ttlSeconds: 600 },
  context: asClaimer(who),
});
function typedOk<T>(reply: TypedReply): T {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.status, "OK", JSON.stringify(reply.body));
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  return reply.body.result as T;
}
function typedFail(reply: TypedReply, status: number, code: string): void {
  assert.equal(reply.status, status, JSON.stringify(reply.body));
  assert.equal(reply.body.status, "FAIL", JSON.stringify(reply.body));
  assert.equal(reply.body.ok, false, JSON.stringify(reply.body));
  assert.equal(reply.body.error?.code, code, JSON.stringify(reply.body));
}
let reads = 0;
const typedRead = async <T>(
  who: Caller,
  op: string,
  input: object,
): Promise<T> =>
  typedOk<T>(
    await typedCall(who, {
      requestId: `read-${(reads += 1)}`,
      op,
      input,
      context: asProject(who),
    }),
  );
const show = (who: Caller, id: string): Promise<Item> =>
  typedRead<Item>(who, "issue.show", { id });
const idsOf = async (who: Caller, op: string): Promise<string[]> =>
  (await typedRead<{ items: readonly Item[] }>(who, op, {})).items
    .map((item) => item.id)
    .sort();
// The rows of state_records in one namespace whose key starts with `prefix`.
const recordsOf = (
  dump: Dump,
  namespace: string,
  prefix: string,
): readonly Record<string, unknown>[] =>
  (dump.tables.state_records ?? []).filter(
    (row) => row.namespace === namespace && String(row.key).startsWith(prefix),
  );
// The stored id behind a shown one: the prefix is only how the id is displayed.
const storedOf = (shown: string): string => shown.replace(/^[^-]+-/, "work-");
// The comments stored on one issue, as written: { id, body }.
const commentsOn = (dump: Dump, shown: string): unknown[] =>
  recordsOf(dump, "forge/work", `comment:${storedOf(shown)}:`).map(
    (row) => (JSON.parse(String(row.body)) as { value: unknown }).value,
  );
// A call whose receipt insert fails: the reply is a 500 INTERNAL and the dump is as it was.
// Returns the dump taken before the call.
async function rolledBack(who: Caller, call: Call): Promise<Dump> {
  const snapshot = await dumpOf(typedProject);
  const failed = await typedCall(who, call, {
    "x-cloud-fault": "receipt-insert",
  });
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.error?.code, "INTERNAL");
  assert.deepEqual(
    await dumpOf(typedProject),
    snapshot,
    `${call.op} left a row`,
  );
  return snapshot;
}

let revokedPhone: Device | undefined;
const revokeCheck = (): Promise<void> =>
  check("a revoked token is refused on its next request", async () => {
    const project = `${run}-revoke`;
    const phone = await issue(project, "phone");
    revokedPhone = phone;
    const laptop = await issue(project, "laptop");
    const holder = {
      ...holderOf("revoke"),
      session: { ...holderOf("revoke").session, id: phone.session },
    };
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
    assert.ok(
      granted(await lookup(project, "issue:revoke-1", asDevice(laptop)))
        .releasedAt,
      first.subject,
    );
  });

// Device login journeys (forge-1230). The deployed Worker has no test wrapper, so live runs skip them.
async function deviceChecks(): Promise<void> {
  const device = live ? skip : check;
  // Owner approval of a device login over real HTTP (forge-1230). Every request names its own address,
  // and a wrong-capability request also arms a fault that fails any write to the login row: its normal
  // 400 proves the request never reached one. The limit journeys arm no fault, so a missing limit shows
  // as a missing 429 and never as a write failure. Public test values only; the Clerk upstream is a test double.
  const browser = (() => {
    let n = 0;
    const fresh = (): string => `192.0.2.${++n}`;
    const origin = new URL(base).origin;
    interface Call {
      form?: Record<string, string>;
      json?: object;
      cookie?: string;
      ip?: string;
      fault?: boolean;
      converge?: string;
    }
    async function call(path: string, init: Call = {}) {
      const response = await fetch(`${base}${path}`, {
        method: init.form || init.json ? "POST" : "GET",
        redirect: "manual",
        headers: {
          "x-cloud-ip": init.ip ?? fresh(),
          ...(init.fault ? { "x-cloud-fault": "login-write" } : {}),
          ...(init.converge ? { "x-cloud-converge": init.converge } : {}),
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...(init.form
            ? { origin, "content-type": "application/x-www-form-urlencoded" }
            : {}),
          ...(init.json ? { "content-type": "application/json" } : {}),
        },
        ...(init.form
          ? { body: new URLSearchParams(init.form).toString() }
          : {}),
        ...(init.json ? { body: JSON.stringify(init.json) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      const word =
        /<code class="result">([^<]+)<\/code>/.exec(text)?.[1] ??
        (text.startsWith("{")
          ? (JSON.parse(text) as { error?: { code?: string } }).error?.code
          : undefined);
      return { status: response.status, text, word, headers: response.headers };
    }
    // A login and its browser preview: the device code, the cookie, both tickets and the selector.
    async function previewed() {
      const start = await call(`/p/${typedProject}/loginstart`, {
        json: { device: "conformance" },
      });
      const login = JSON.parse(start.text) as {
        user_code: string;
        device_code: string;
      };
      const page = await call("/device");
      const csrf =
        /__Host-forge_device=([^;]+)/.exec(
          page.headers.get("set-cookie") ?? "",
        )?.[1] ?? "";
      const cookie = `__Host-forge_device=${csrf}`;
      const shown = await call("/device", {
        form: { csrf, code: login.user_code },
        cookie,
      });
      const pick = (pattern: RegExp): string =>
        pattern.exec(shown.text)?.[1] ?? "";
      return {
        deviceCode: login.device_code,
        csrf,
        cookie,
        selector: pick(/name="challenge" value="([^"]*)"/),
        ticket: (action: "approve" | "deny"): string =>
          pick(
            new RegExp(
              `action="/device/${action}">[^]*?name="ticket" value="([^"]+)"`,
            ),
          ),
      };
    }
    type Flow = Awaited<ReturnType<typeof previewed>>;
    const decide = (
      f: Flow,
      action: "approve" | "deny",
      ticket: string,
      more: Call & { selector?: string } = {},
    ) =>
      call(`/device/${action}`, {
        ...more,
        form: {
          csrf: f.csrf,
          ticket,
          challenge: more.selector ?? f.selector,
        },
        cookie: f.cookie,
      });
    const bindOf = (decision: { headers: Headers }): string =>
      (decision.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // The return from Clerk, with the owner's proof, carrying the given cookie.
    const back = (
      decision: { headers: Headers },
      cookie: string,
      fault = false,
    ) => {
      const state =
        new URL(decision.headers.get("location") ?? "").searchParams.get("s") ??
        "";
      const query = new URLSearchParams({
        state,
        code: "owner",
      });
      return call(`/callback?${query}`, { cookie, fault });
    };
    const poll = (f: Flow) =>
      call(`/p/${typedProject}/loginpoll`, {
        json: { device_code: f.deviceCode },
      });
    return { previewed, decide, bindOf, back, poll };
  })();
  const WRONG = "x".repeat(43);
  const outcomeOf = (reply: { status: number; word?: string | undefined }) => [
    reply.status,
    reply.word,
  ];

  for (const action of ["approve", "deny"] as const) {
    await device(
      `device ${action}: wrong capabilities write no login row and the right ones still complete`,
      async () => {
        const f = await browser.previewed();
        const swap = action === "approve" ? "deny" : "approve";
        for (const reply of [
          await browser.decide(f, action, WRONG, { fault: true }),
          await browser.decide(f, action, f.ticket(swap), { fault: true }),
          await browser.decide(f, action, f.ticket(action), {
            selector: "",
            fault: true,
          }),
        ])
          assert.deepEqual(outcomeOf(reply), [400, "invalid_request"]);
        const decision = await browser.decide(f, action, f.ticket(action));
        assert.equal(decision.status, 302, decision.text);
        const own = browser.bindOf(decision);
        const wrongBrowser = await browser.back(
          decision,
          `${own.split("=")[0]}=${WRONG}`,
          true,
        );
        assert.deepEqual(outcomeOf(wrongBrowser), [400, "access_denied"]);
        const done = await browser.back(decision, own);
        assert.deepEqual(outcomeOf(done), [
          200,
          action === "approve" ? "approved" : "denied",
        ]);
        assert.ok(
          !done.text.includes("fct_"),
          "a browser reply has no credential",
        );
        const polled = await browser.poll(f);
        assert.equal(polled.status, action === "approve" ? 200 : 400);
        assert.equal((await browser.poll(f)).status, 400);
      },
    );
  }

  await device(
    "device: the sixth attempt for one challenge, from another address, is rate limited",
    async () => {
      const f = await browser.previewed();
      for (let n = 0; n < 5; n++)
        assert.deepEqual(outcomeOf(await browser.decide(f, "approve", WRONG)), [
          400,
          "invalid_request",
        ]);
      const sixth = await browser.decide(f, "approve", f.ticket("approve"));
      assert.deepEqual(outcomeOf(sixth), [429, "rate_limited"]);
    },
  );

  await device(
    "device: the sixth attempt from one address is rate limited, whatever the challenge",
    async () => {
      const ip = "198.51.100.9";
      for (let n = 0; n < 5; n++) {
        const f = await browser.previewed();
        const reply = await browser.decide(f, "approve", WRONG, { ip });
        assert.deepEqual(outcomeOf(reply), [400, "invalid_request"]);
      }
      const f = await browser.previewed();
      const sixth = await browser.decide(f, "approve", f.ticket("approve"), {
        ip,
      });
      assert.deepEqual(outcomeOf(sixth), [429, "rate_limited"]);
    },
  );

  await device(
    "device: six overlapping attempts admit exactly five",
    async () => {
      const f = await browser.previewed();
      const replies = await Promise.all(
        Array.from({ length: 6 }, () =>
          browser.decide(f, "approve", WRONG, { converge: `overlap-${run}:6` }),
        ),
      );
      assert.deepEqual(
        replies.map((reply) => reply.status).sort(),
        [400, 400, 400, 400, 400, 429],
        JSON.stringify(replies.map((reply) => reply.text.slice(0, 120))),
      );
    },
  );
}

if (phase === "revoke") await revokeCheck();
if (phase === "device") {
  await issue(typedProject, "device-journeys");
  await deviceChecks();
}

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
        holder: onDevice(asSession(holderOf("auth"), device), "tablet"),
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
    const holder = asSession(holderOf("device"), tablet);
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
    // A session-bound token cannot name another session.
    const other = { ...holder, session: { ...session, id: "session-other" } };
    const forged = await claimAs(other, "device-3");
    assert.equal(forged.status, 403, JSON.stringify(forged.body));
    assert.equal(forged.body.error?.code, "AUTH_DEVICE_MISMATCH");
    assert.equal(
      forged.body.error?.message,
      "The request names a session other than the token's",
    );
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
      noLease(await holderLookup(project, subject));
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
    "a holder lookup that fails is not read as an empty lease",
    () => {
      const failed = (status: number, ok: boolean): Reply => ({
        status,
        body: { ok, error: { code: "INTERNAL", message: "no lookup" } },
      });
      assert.throws(() => noLease(failed(500, false)));
      assert.throws(() => noLease(failed(401, false)));
      assert.throws(() => noLease(failed(200, false)));
      assert.throws(() =>
        noLease({ status: 500, body: { ok: true, value: null } }),
      );
      noLease({ status: 200, body: { ok: true, value: null } });
      return Promise.resolve();
    },
  );

  await faulty(
    "overlapping requests to one project: only the request with the fault header gets the fault",
    async () => {
      const project = `${run}-overlap`;
      await tokenFor(project);
      const pairs = Array.from({ length: 12 }, (_, index) => index);
      // Each pair is forced to overlap inside the fault wrapper: the faulted claim pauses there until
      // its plain partner has entered, then resumes while the partner is still running. A serial run
      // cannot get past the pause, and a fault flag shared between requests is lost to the partner.
      const sent = await Promise.all(
        pairs.flatMap((index) => [
          send(
            project,
            "POST",
            "claim",
            {
              subject: `issue:overlap-fault-${index}`,
              holder: holderOf("overlap", index),
              ttlMs: 600_000,
              requestId: `overlap-fault-${index}`,
            },
            {
              "x-cloud-fault": "receipt-insert",
              "x-cloud-hold": `overlap-${index}`,
            },
          ),
          send(
            project,
            "POST",
            "claim",
            {
              subject: `issue:overlap-plain-${index}`,
              holder: holderOf("overlap", index),
              ttlMs: 600_000,
              requestId: `overlap-plain-${index}`,
            },
            { "x-cloud-after": `overlap-${index}` },
          ),
        ]),
      );
      sent.forEach((reply, position) => {
        const label = `${position % 2 === 0 ? "faulted" : "plain"} request ${Math.floor(position / 2)}`;
        if (position % 2 === 0) {
          assert.equal(
            reply.status,
            500,
            `${label}: ${JSON.stringify(reply.body)}`,
          );
          assert.equal(reply.body.error?.code, "INTERNAL", label);
        } else {
          granted(reply);
        }
      });
      for (const index of pairs) {
        noLease(await holderLookup(project, `issue:overlap-fault-${index}`));
      }
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
    "a restore whose rows are not valid state is refused as RESTORE_INVALID_ROW and writes nothing",
    async () => {
      const source = `${run}-invalid-src`;
      const holder = holderOf("invalid");
      const first = granted(
        await claim(source, "issue:bad-1", holder, "invalid-1"),
      );
      granted(
        await send(source, "POST", "renew", {
          subject: "issue:bad-1",
          holder,
          generation: first.generation,
          ttlMs: 900_000,
          requestId: "invalid-renew",
        }),
      );
      granted(await claim(source, "issue:bad-2", holder, "invalid-2"));
      const dump = await dumpOf(source);
      assert.ok(dump.tables.state_events!.length >= 3, "events");
      assert.ok(dump.tables.state_requests!.length >= 2, "owner receipts");
      assert.ok(dump.tables.domain_cloud_requests!.length >= 3, "receipts");

      // Each case copies the valid dump and breaks one body, keeping every row well shaped.
      type Edit = (tables: Record<string, Record<string, unknown>[]>) => void;
      const cases: Record<string, { table: string; edit: Edit }> = {
        "lease body is not JSON": {
          table: "state_leases",
          edit: (tables) => {
            tables.state_leases![0]!.body = "not json";
          },
        },
        "lease body is an empty object": {
          table: "state_leases",
          edit: (tables) => {
            tables.state_leases![0]!.body = "{}";
          },
        },
        "lease body generation differs from its column": {
          table: "state_leases",
          edit: (tables) => {
            const row = tables.state_leases![0]!;
            const lease = JSON.parse(String(row.body)) as {
              generation: number;
            };
            lease.generation += 1;
            row.body = JSON.stringify(lease);
          },
        },
        "lease body names another subject": {
          table: "state_leases",
          edit: (tables) => {
            const row = tables.state_leases![0]!;
            const lease = JSON.parse(String(row.body)) as { subject: string };
            lease.subject = `${lease.subject}-other`;
            row.body = JSON.stringify(lease);
          },
        },
        "event body is not an event": {
          table: "state_events",
          edit: (tables) => {
            tables.state_events![0]!.body = '{"type":"nope"}';
          },
        },
        "event body is not JSON": {
          table: "state_events",
          edit: (tables) => {
            tables.state_events![1]!.body = "not json";
          },
        },
        "owner receipt result is not JSON": {
          table: "state_requests",
          edit: (tables) => {
            tables.state_requests![0]!.result = "not json";
          },
        },
        "server receipt result is not JSON": {
          table: "domain_cloud_requests",
          edit: (tables) => {
            tables.domain_cloud_requests![0]!.result = "not json";
          },
        },
        "server receipt result is another subject's lease": {
          table: "domain_cloud_requests",
          edit: (tables) => {
            const row = tables.domain_cloud_requests!.find(
              (candidate) => candidate.outcome === "ok",
            )!;
            const lease = JSON.parse(String(row.result)) as { subject: string };
            lease.subject = `${lease.subject}-other`;
            row.result = JSON.stringify(lease);
          },
        },
      };
      const target = `${run}-invalid-dst`;
      for (const [name, { table, edit }] of Object.entries(cases)) {
        const tables = (
          JSON.parse(JSON.stringify(dump)) as {
            tables: Record<string, Record<string, unknown>[]>;
          }
        ).tables;
        edit(tables);
        const reply = await adminCall(
          target,
          "POST",
          "restore",
          JSON.stringify({ format: dump.format, tables }),
        );
        assert.equal(
          reply.status,
          400,
          `${name}: ${JSON.stringify(reply.body)}`,
        );
        assert.equal(reply.body.error?.code, "RESTORE_INVALID_ROW", name);
        assert.ok(
          reply.body.error?.message.includes(table),
          `${name}: the refusal names ${table}: ${reply.body.error?.message}`,
        );
        assert.equal(await initialized(target), false, name);
        const after = await dumpOf(target);
        for (const rows of Object.values(after.tables))
          assert.equal(rows.length, 0, `${name}: nothing was written`);
      }

      // A refused restore leaves the project empty, so the valid dump still restores and reads back identical.
      const valid = await adminCall(
        target,
        "POST",
        "restore",
        JSON.stringify(dump),
      );
      assert.equal(valid.status, 200, JSON.stringify(valid.body));
      assert.deepEqual(await dumpOf(target), dump, "read back identical");
      assert.deepEqual(
        granted(await holderLookup(target, "issue:bad-1")),
        granted(await holderLookup(source, "issue:bad-1")),
      );
    },
  );

  // The test config (wrangler.test.jsonc) sets a 4096-byte page and a 131072-byte project limit, so a
  // small project needs several pages and a larger one trips the size guard.
  let paged: Promise<{ source: string; pages: DumpPage[] }> | undefined;
  const pagedSource = (): Promise<{ source: string; pages: DumpPage[] }> =>
    (paged ??= (async () => {
      const source = `${run}-page-a`;
      for (let i = 0; i < 12; i += 1)
        granted(
          await claim(source, `issue:page-${i}`, holderOf("page"), `page-${i}`),
        );
      return { source, pages: await pagesOf(source) };
    })());

  await check(
    "a project dumps in byte-bounded pages and restores the same pages into an empty project, read back identical",
    async () => {
      const { source, pages } = await pagedSource();
      const target = `${run}-page-b`;
      assert.ok(pages.length >= 3, `${pages.length} pages`);
      pages.forEach((page, index) => {
        assert.equal(page.page, index);
        assert.equal(page.last, index === pages.length - 1);
        assert.ok(
          Buffer.byteLength(JSON.stringify(page)) <= 4096 + 512,
          `page ${index} is about 4096 bytes`,
        );
      });
      const whole = await dumpOf(source);
      for (const [table, rows] of Object.entries(whole.tables))
        assert.deepEqual(
          pages.flatMap((page) => page.tables[table]!),
          rows,
          `${table}: the pages hold the same rows as the whole dump`,
        );
      for (const page of pages) {
        const reply = await sendPage(target, page);
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.equal((reply.body.value as { done: boolean }).done, page.last);
        assert.equal(await initialized(target), page.last, `page ${page.page}`);
      }
      assert.deepEqual(await dumpOf(target), whole, "read back identical");
      assert.deepEqual(await pagesOf(target), pages, "same pages");
      assert.deepEqual(
        granted(await holderLookup(target, "issue:page-3")),
        granted(await holderLookup(source, "issue:page-3")),
      );
      assert.deepEqual(
        granted(
          await claim(target, "issue:page-4", holderOf("page"), "page-4"),
        ),
        granted(
          await claim(source, "issue:page-4", holderOf("page"), "page-4"),
        ),
      );
      const again = await sendPage(target, pages[0]);
      assert.equal(again.status, 409, JSON.stringify(again.body));
      assert.equal(again.body.error?.code, "RESTORE_TARGET_NOT_EMPTY");
    },
  );

  await check(
    "pages restore in order only, and a half restore is abandoned by starting again at page 0",
    async () => {
      const { source, pages } = await pagedSource();
      const target = `${run}-page-half`;
      assert.equal((await sendPage(target, pages[1])).status, 400, "not first");
      assert.equal((await sendPage(target, pages[0])).status, 200);
      assert.equal((await sendPage(target, pages[1])).status, 200);
      const skipped = await sendPage(target, pages[3]);
      assert.equal(skipped.status, 400, JSON.stringify(skipped.body));
      assert.equal(skipped.body.error?.code, "INPUT_INVALID");
      const repeated = await sendPage(target, pages[1]);
      assert.equal(repeated.status, 400, JSON.stringify(repeated.body));
      assert.ok(
        repeated.body.error?.message.includes("send page 0 first"),
        "the refused skip ended the session",
      );
      assert.equal(await initialized(target), false, "half restored");
      // Abandon: page 0 again clears what was staged, then the whole set goes in.
      for (const page of pages) {
        const reply = await sendPage(target, page);
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
      }
      assert.deepEqual(await dumpOf(target), await dumpOf(source));

      // Issuing a device token provisions a project, so it clears staged rows that were never checked.
      const issued = `${run}-page-issued`;
      assert.equal((await sendPage(issued, pages[0])).status, 200);
      assert.equal((await sendPage(issued, pages[1])).status, 200);
      await issue(issued, "tablet");
      for (const rows of Object.values((await dumpOf(issued)).tables))
        assert.equal(rows.length, 0, "no staged row survives a token");
      assert.equal(
        (await sendPage(issued, pages[2])).status,
        409,
        "provisioned",
      );

      // A refused page ends the session: after page 0 and a skipped page, page 1 needs page 0 first.
      const order = `${run}-page-order`;
      assert.equal((await sendPage(order, pages[0])).status, 200);
      assert.equal((await sendPage(order, pages[2])).status, 400, "skipped");
      const late = await sendPage(order, pages[1]);
      assert.equal(late.status, 400, JSON.stringify(late.body));
      assert.ok(late.body.error?.message.includes("send page 0 first"));
    },
  );

  await check(
    "a write between dump pages makes the next page DUMP_CHANGED, and a fresh export restores identical",
    async () => {
      const race = `${run}-page-race`;
      const holder = holderOf("race");
      const first = granted(
        await claim(race, "issue:race-0", holder, "race-0"),
      );
      for (let i = 1; i < 12; i += 1)
        granted(await claim(race, `issue:race-${i}`, holder, `race-${i}`));
      const next = async (cursor: string): ReturnType<typeof adminCall> =>
        adminCall(race, "GET", `dump?cursor=${encodeURIComponent(cursor)}`);
      const changed = (reply: Awaited<ReturnType<typeof adminCall>>): void => {
        assert.equal(reply.status, 409, JSON.stringify(reply.body));
        assert.equal(reply.body.error?.code, "DUMP_CHANGED");
      };

      // A renewal (an event and a receipt) between page 0 and page 1.
      const page0 = (await next("start")).body.value as DumpPage;
      assert.ok(page0.next !== null, "more than one page");
      granted(
        await send(race, "POST", "renew", {
          subject: "issue:race-0",
          holder,
          generation: first.generation,
          ttlMs: 900_000,
          requestId: "race-renew",
        }),
      );
      changed(await next(page0.next));

      // A refused claim writes a receipt only, and that changes the project too.
      const again = (await next("start")).body.value as DumpPage;
      refused(
        await claim(race, "issue:race-0", holderOf("rival"), "race-rival"),
        "LEASE_HELD",
      );
      changed(await next(again.next!));

      // With nothing written between pages, the export restores identical.
      const pages = await pagesOf(race);
      assert.ok(pages.length >= 3, `${pages.length} pages`);
      const target = `${run}-page-race-copy`;
      for (const page of pages)
        assert.equal((await sendPage(target, page)).status, 200);
      assert.deepEqual(await dumpOf(target), await dumpOf(race));
    },
  );

  await check(
    "a paged restore runs the same row checks on the whole staged set, and a refusal leaves nothing staged",
    async () => {
      const { pages } = await pagedSource();
      const target = `${run}-page-bad`;
      const copy = JSON.parse(JSON.stringify(pages)) as DumpPage[];
      const leases = copy.find((page) => page.tables.state_leases!.length > 0)!;
      (leases.tables.state_leases![0] as Record<string, unknown>).body =
        "not json";
      for (const page of copy) {
        const reply = await sendPage(target, page);
        if (!page.last) {
          assert.equal(reply.status, 200, JSON.stringify(reply.body));
          continue;
        }
        assert.equal(reply.status, 400, JSON.stringify(reply.body));
        assert.equal(reply.body.error?.code, "RESTORE_INVALID_ROW");
        assert.ok(reply.body.error?.message.includes("state_leases"));
      }
      assert.equal(await initialized(target), false);
      assert.equal((await sendPage(target, pages[1])).status, 400, "abandoned");
      for (const page of pages)
        assert.equal((await sendPage(target, page)).status, 200);
      assert.equal(await initialized(target), true);
    },
  );

  await check(
    "the size guard refuses a dump over the project limit, and a restore whose staged rows pass it, before rows load",
    async () => {
      const big = `${run}-page-big`;
      const holder = holderOf("big");
      const claims = await Promise.all(
        Array.from({ length: 150 }, (_, i) =>
          claim(big, `issue:big-${i}`, holder, `big-${i}`),
        ),
      );
      claims.forEach((reply) => granted(reply));
      for (const route of ["dump", "dump?cursor=start"]) {
        const reply = await adminCall(big, "GET", route);
        assert.equal(
          reply.status,
          413,
          `${route}: ${JSON.stringify(reply.body)}`,
        );
        assert.equal(reply.body.error?.code, "DUMP_TOO_LARGE");
      }
      const target = `${run}-page-guard`;
      const record = (index: number): object => ({
        format: "forge-cloud-dump-page/1",
        page: index,
        last: false,
        next: "more",
        tables: {
          state_records: [
            {
              namespace: "n",
              key: `k${index}`,
              revision: 1,
              body: "x".repeat(80_000),
            },
          ],
          state_events: [],
          state_leases: [],
          state_requests: [],
          domain_cloud_requests: [],
        },
      });
      // The page that crosses the limit is the page that is refused: 80,000 fits, 160,000 does not.
      assert.equal((await sendPage(target, record(0))).status, 200);
      const over = await sendPage(target, record(1));
      assert.equal(over.status, 413, JSON.stringify(over.body));
      assert.equal(over.body.error?.code, "RESTORE_TOO_LARGE");
      assert.equal(await initialized(target), false);
      const late = await sendPage(target, record(1));
      assert.equal(late.status, 400, JSON.stringify(late.body));
      assert.ok(late.body.error?.message.includes("send page 0 first"));

      // The row limit (100 per table in the test config) is checked in SQL the same way.
      const many = record(0) as { tables: Record<string, unknown[]> };
      many.tables.state_records = Array.from({ length: 101 }, (_, i) => ({
        namespace: "n",
        key: `k${i}`,
        revision: 1,
        body: "{}",
      }));
      const crowded = await sendPage(`${run}-page-rows`, many);
      assert.equal(crowded.status, 413, JSON.stringify(crowded.body));
      assert.equal(crowded.body.error?.code, "RESTORE_TOO_LARGE");
      assert.ok(crowded.body.error?.message.includes("state_records"));

      // A cursor must have an integer table index and a key of that table's types, and a page-0
      // cursor starts the first table and runs the same guard as "start".
      const cursor = (value: object): ReturnType<typeof adminCall> =>
        adminCall(
          big,
          "GET",
          `dump?cursor=${encodeURIComponent(JSON.stringify(value))}`,
        );
      for (const bad of [
        { p: 0, t: "1", k: null, w: "" },
        { p: 0, t: null, k: null, w: "" },
        { p: 0, t: 1, k: null, w: "" },
        { p: 1, t: 1, k: ["x"], w: "" },
        { p: 1, t: 1, k: [1], w: 5 },
      ]) {
        const reply = await cursor(bad);
        assert.equal(reply.status, 400, JSON.stringify([bad, reply.body]));
      }
      const skipGuard = await cursor({ p: 0, t: 0, k: null, w: "" });
      assert.equal(skipGuard.status, 413, JSON.stringify(skipGuard.body));
      assert.equal(skipGuard.body.error?.code, "DUMP_TOO_LARGE");
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
      // The Worker refuses from the Content-Length header and closes the connection, so a client that
      // is still uploading 9 MiB can lose the reply (ECONNRESET). This request sends the header and
      // no body, so it always reads the 413.
      const reply = await refusedBeforeUpload(project, 9 * 1024 * 1024);
      assert.equal(reply.status, 413, JSON.stringify(reply.body));
      assert.equal(reply.body.error?.code, "RESTORE_TOO_LARGE");
      assert.equal(await initialized(project), false);
    },
  );

  // The typed command route on real workerd: cases 1 to 9, the links case and the comments case run in order on the admitted project and
  // share what they create. The deployed Worker has no fault switch and a live run names no admitted
  // project, so live runs skip them.
  const typed = live ? skip : check;
  let a!: Caller;
  let b!: Caller;
  let c!: Caller;
  let one!: Item;
  let two!: Item;
  let third!: Item;
  let winner!: Caller;
  let loser!: Caller;
  let raced!: Grant;
  const createOne: Call = {
    requestId: "typed-create-1",
    op: "issue.create",
    input: {
      title: "First",
      body: "first body",
      kind: "feature",
      labels: ["typed"],
    },
    context: {},
  };
  const noteOn = (id: string): Call => ({
    requestId: "typed-comment-1",
    op: "issue.comment",
    input: { id, body: "first note" },
    context: {},
  });
  let created!: Item;
  let noted!: { id: string; commentId: string };
  let typedSaved: TypedSaved | undefined;

  await typed(
    "typed 1: create, comment, show, list and ready on the admitted project",
    async () => {
      assert.notEqual(typedProject, "", "FORGE_CLOUD_PROJECT is set");
      // Issuing the first token provisions the admitted project.
      a = await callerFor("a");
      b = await callerFor("b");
      c = await callerFor("c", false);
      created = typedOk<Item>(
        await typedCall(a, { ...createOne, context: asProject(a) }),
      );
      assert.match(created.id, /^ci-\d+$/);
      assert.equal(created.status, "open");
      assert.equal(created.revision, 1);
      one = created;
      two = typedOk<Item>(
        await typedCall(a, {
          requestId: "typed-create-2",
          op: "issue.create",
          input: { title: "Second" },
          context: asProject(a),
        }),
      );
      assert.match(two.id, /^ci-\d+$/);
      assert.notEqual(two.id, one.id);
      noted = typedOk(
        await typedCall(a, { ...noteOn(one.id), context: asProject(a) }),
      );
      assert.equal(noted.id, one.id);
      assert.match(noted.commentId, /^comment:work-\d+:1$/);
      assert.deepEqual(await show(a, one.id), one);
      assert.deepEqual(await show(a, two.id), two);
      // What was stored is what was sent, not only what the create reply said.
      const { title, body, kind, labels } = one;
      assert.deepEqual({ title, body, kind, labels }, createOne.input);
      assert.equal(two.title, "Second");
      assert.deepEqual(
        [two.body, two.kind, two.labels],
        [undefined, undefined, []],
      );
      assert.deepEqual(await idsOf(a, "issue.list"), [one.id, two.id].sort());
      assert.deepEqual(await idsOf(a, "issue.ready"), [one.id, two.id].sort());
    },
  );

  await typed(
    "typed 2: a claim takes the first issue out of ready at generation 1",
    async () => {
      const grant = typedOk<Grant>(
        await typedCall(a, claimOf("typed-claim-1", a, one.id)),
      );
      assert.equal(grant.id, one.id);
      assert.equal(grant.generation, 1);
      assert.deepEqual(await idsOf(a, "issue.ready"), [two.id]);
      one = await show(a, one.id);
      assert.equal(one.lease?.generation, 1);
    },
  );

  await typed(
    "typed 3: an update takes the returned revision, and the old revision is refused",
    async () => {
      const edit = (requestId: string, expectRevision: number, title: string) =>
        typedCall(a, {
          requestId,
          op: "issue.update",
          input: { id: one.id, expectRevision, title },
          context: asHolder(a, 1),
        });
      const updated = typedOk<Item>(
        await edit("typed-update-1", one.revision, "First edited"),
      );
      assert.equal(updated.title, "First edited");
      assert.equal(updated.revision, one.revision + 1);
      typedFail(
        await edit("typed-update-2", one.revision, "Stale"),
        409,
        "REVISION_CONFLICT",
      );
      one = await show(a, one.id);
      assert.equal(one.title, "First edited");
      assert.equal(one.revision, updated.revision);
    },
  );

  await typed(
    "typed 4: two devices race for the second issue: one grant, one LEASE_HELD",
    async () => {
      const racers = [b, c];
      const replies = await Promise.all(
        racers.map((who, index) =>
          typedCall(who, claimOf(`typed-race-${index}`, who, two.id)),
        ),
      );
      const won = replies.findIndex((reply) => reply.status === 200);
      assert.equal(
        replies.filter((reply) => reply.status === 200).length,
        1,
        JSON.stringify(replies.map((reply) => reply.body)),
      );
      winner = racers[won]!;
      loser = racers[1 - won]!;
      raced = typedOk<Grant>(replies[won]!);
      assert.equal(raced.generation, 1);
      typedFail(replies[1 - won]!, 409, "LEASE_HELD");
      // The winner's lease is untouched, under the session it named.
      two = await show(a, two.id);
      assert.equal(two.lease?.generation, 1);
      assert.equal(two.lease?.holder.session.id, winner.session);
    },
  );

  await typed(
    "typed 5: the winner renews and releases, and the loser claims at generation 2",
    async () => {
      await sleep(50);
      const renewed = typedOk<Grant>(
        await typedCall(winner, {
          requestId: "typed-renew-1",
          op: "issue.renew",
          input: { id: two.id, ttlSeconds: 600 },
          context: asHolder(winner, 1),
        }),
      );
      assert.equal(renewed.generation, 1);
      // The stored lease is the renewed one: same holder and generation, the returned expiry, later than the claim's.
      const stored = (await show(a, two.id)).lease;
      assert.equal(stored?.expiresAt, renewed.expiresAt);
      assert.equal(stored?.generation, 1);
      assert.deepEqual(stored?.holder, two.lease?.holder);
      assert.ok(Date.parse(renewed.expiresAt) > Date.parse(raced.expiresAt));
      const released = typedOk<{ id: string }>(
        await typedCall(winner, {
          requestId: "typed-release-1",
          op: "issue.release",
          input: { id: two.id },
          context: asHolder(winner, 1),
        }),
      );
      assert.equal(released.id, two.id);
      assert.equal((await show(a, two.id)).lease, undefined);
      const next = typedOk<Grant>(
        await typedCall(loser, claimOf("typed-claim-2", loser, two.id)),
      );
      assert.equal(next.generation, 2);
      two = await show(a, two.id);
      assert.equal(two.lease?.holder.session.id, loser.session);
    },
  );

  await typed(
    "typed 6: a dependency is added, and the cycle back is refused",
    async () => {
      const added = typedOk<Item>(
        await typedCall(a, {
          requestId: "typed-dep-1",
          op: "issue.dep",
          input: {
            id: one.id,
            target: two.id,
            action: "add",
            expectRevision: one.revision,
          },
          context: asHolder(a, 1),
        }),
      );
      assert.deepEqual(added.dependsOn, [two.id]);
      typedFail(
        await typedCall(loser, {
          requestId: "typed-dep-2",
          op: "issue.dep",
          input: {
            id: two.id,
            target: one.id,
            action: "add",
            expectRevision: two.revision,
          },
          context: asHolder(loser, 2),
        }),
        409,
        "INPUT_CONFLICT",
      );
      one = await show(a, one.id);
      two = await show(a, two.id);
      assert.deepEqual(one.dependsOn, [two.id]);
      assert.deepEqual(two.dependsOn, []);
    },
  );

  // The first issue is still held by a at generation 1: a link is evidence attached to it, so the dump gains one record,
  // one work event and one receipt, and no issue row or lease changes.
  const linkInputUrl = "https://example.com/pull/9";
  const linkTo = (id: string): Call => ({
    requestId: "typed-link-1",
    op: "issue.link",
    input: { id, relation: "delivers", url: linkInputUrl },
    context: asHolder(a, 1),
  });
  interface LinkRecord {
    readonly namespace: string;
    readonly key: string;
    readonly revision: number;
    readonly value: object;
    readonly updatedBy: unknown;
  }
  let linked!: LinkRecord;
  const eventsIn = (dump: Dump, namespace: string): number =>
    (dump.tables.state_events ?? []).filter(
      (row) => row.namespace === namespace,
    ).length;
  await typed(
    "typed link: a holder appends a link, a replay appends nothing, other input conflicts and a non-holder is refused",
    async () => {
      const before = await dumpOf(typedProject);
      const call = linkTo(one.id);
      const record = typedOk<LinkRecord>(await typedCall(a, call));
      const key = `link:${storedOf(one.id)}:1`;
      assert.deepEqual(
        [record.namespace, record.key, record.revision, record.value],
        [
          "forge/work",
          key,
          1,
          { id: storedOf(one.id), relation: "delivers", url: linkInputUrl },
        ],
      );
      assert.deepEqual(record.updatedBy, a.actor);
      linked = record;
      const after = await dumpOf(typedProject);
      assert.deepEqual(
        recordsOf(after, "forge/work", "link:").map(
          (row) => JSON.parse(String(row.body)) as unknown,
        ),
        [record],
      );
      assert.equal(
        eventsIn(after, "forge/work"),
        eventsIn(before, "forge/work") + 1,
      );
      assert.equal(
        recordsOf(after, "forge/cloud", "request:typed-link-1").length,
        1,
      );
      assert.deepEqual(
        recordsOf(after, "forge/work", "issue:"),
        recordsOf(before, "forge/work", "issue:"),
      );
      assert.deepEqual(await show(a, one.id), one);
      // A replay returns the original record and writes nothing; other input under the id conflicts.
      assert.deepEqual(typedOk(await typedCall(a, call)), record);
      typedFail(
        await typedCall(a, {
          ...call,
          input: { ...call.input, url: "https://example.com/pull/10" },
        }),
        409,
        "INPUT_CONFLICT",
      );
      assert.deepEqual(await dumpOf(typedProject), after, "a replay wrote");
      // The holder of the other issue cannot link this one. The lease engine checks the generation before the holder,
      // so the caller names the issue's own generation (1) to reach the holder check.
      typedFail(
        await typedCall(loser, {
          ...linkTo(one.id),
          requestId: "typed-link-2",
          context: asHolder(loser, 1),
        }),
        409,
        "LEASE_NOT_HELD",
      );
      assert.deepEqual(await dumpOf(typedProject), after, "a refusal wrote");
    },
  );

  await typed(
    "typed links: the holder appends ten more links, a, b and c read all eleven in link-number order, and a read writes nothing",
    async () => {
      const links = (who: Caller, id: string) =>
        typedCall(who, {
          requestId: `typed-links-${(reads += 1)}`,
          op: "issue.links",
          input: { id },
          context: asProject(who),
        });
      for (let n = 2; n <= 11; n += 1)
        typedOk(
          await typedCall(a, {
            ...linkTo(one.id),
            requestId: `typed-link-n${n}`,
            input: {
              id: one.id,
              relation: "delivers",
              url: `${linkInputUrl}/${n}`,
            },
          }),
        );
      const before = await dumpOf(typedProject);
      const number = (record: LinkRecord) => Number(record.key.split(":")[2]);
      const stored = recordsOf(
        before,
        "forge/work",
        `link:${storedOf(one.id)}:`,
      )
        .map((row) => JSON.parse(String(row.body)) as LinkRecord)
        .sort((x, y) => number(x) - number(y));
      // Numeric order puts link 10 after link 9; the text order of the keys would not.
      assert.deepEqual(stored.map(number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      assert.deepEqual(stored[0], linked);
      for (const who of [a, b, c])
        assert.deepEqual(typedOk(await links(who, one.id)), {
          records: stored,
        });
      assert.deepEqual(typedOk(await links(a, two.id)), { records: [] });
      const missing = `${two.id.replace(/-.*/, "").toUpperCase()}-99999`;
      const gone = await links(a, missing);
      typedFail(gone, 404, "NOT_FOUND");
      assert.equal(gone.body.error?.message, `Issue ${missing} was not found`);
      assert.deepEqual(await dumpOf(typedProject), before, "a read wrote");
    },
  );

  await typed(
    "typed 7: closing the dependency, and releasing the first issue, makes it ready",
    async () => {
      // The first issue waits on an open dependency and a lease, the second is held: nothing is ready.
      assert.deepEqual(await idsOf(a, "issue.ready"), []);
      const closed = typedOk<Item>(
        await typedCall(loser, {
          requestId: "typed-close-1",
          op: "issue.close",
          input: { id: two.id, withoutReceipt: "conformance run" },
          context: asHolder(loser, 2),
        }),
      );
      assert.equal(closed.status, "closed");
      two = await show(a, two.id);
      assert.equal(two.status, "closed");
      // The dependency is closed, but a live lease still holds the first issue.
      assert.deepEqual(await idsOf(a, "issue.ready"), []);
      typedOk(
        await typedCall(a, {
          requestId: "typed-release-2",
          op: "issue.release",
          input: { id: one.id },
          context: asHolder(a, 1),
        }),
      );
      assert.deepEqual(await idsOf(a, "issue.ready"), [one.id]);
      one = await show(a, one.id);
    },
  );

  await typed(
    "typed link release: after the holder released the issue, the link replay is LEASE_STALE and never the old record",
    async () => {
      const before = await dumpOf(typedProject);
      const reply = await typedCall(a, linkTo(one.id));
      typedFail(reply, 409, "LEASE_STALE");
      assert.ok(!JSON.stringify(reply.body).includes(linkInputUrl));
      assert.ok(!JSON.stringify(reply.body).includes(linked.key));
      assert.deepEqual(await dumpOf(typedProject), before, "a replay wrote");
    },
  );

  await typed(
    "typed 8: a replay returns the recorded result and writes nothing, and other input is INPUT_CONFLICT",
    async () => {
      const before = await dumpOf(typedProject);
      assert.deepEqual(
        typedOk<Item>(
          await typedCall(a, { ...createOne, context: asProject(a) }),
        ),
        created,
      );
      assert.deepEqual(
        typedOk(
          await typedCall(a, { ...noteOn(one.id), context: asProject(a) }),
        ),
        noted,
      );
      assert.deepEqual(await dumpOf(typedProject), before, "a replay wrote");
      assert.deepEqual(await idsOf(a, "issue.list"), [one.id, two.id].sort());
      assert.deepEqual(commentsOn(before, one.id), [
        { id: storedOf(one.id), body: "first note" },
      ]);
      typedFail(
        await typedCall(a, {
          ...createOne,
          input: { title: "Different" },
          context: asProject(a),
        }),
        409,
        "INPUT_CONFLICT",
      );
      typedFail(
        await typedCall(a, {
          ...noteOn(one.id),
          input: { id: one.id, body: "other note" },
          context: asProject(a),
        }),
        409,
        "INPUT_CONFLICT",
      );
      assert.deepEqual(await dumpOf(typedProject), before, "a conflict wrote");
    },
  );

  await typed(
    "typed 9: a session-bound token naming another session is AUTH_DEVICE_MISMATCH",
    async () => {
      const before = await dumpOf(typedProject);
      const reply = await typedCall(b, {
        ...claimOf("typed-mismatch-1", b, one.id),
        context: { actor: b.actor, session: { id: "session-someone-else" } },
      });
      typedFail(reply, 403, "AUTH_DEVICE_MISMATCH");
      assert.equal(
        reply.body.error?.message,
        "The request names a session other than the token's",
      );
      assert.deepEqual(await dumpOf(typedProject), before, "the refusal wrote");
    },
  );

  await typed(
    "typed comments: two devices append to the unnoted issue, a, b and c read both in append order, and a read writes nothing",
    async () => {
      const notes = (who: Caller, id: string) =>
        typedCall(who, {
          requestId: `typed-notes-${(reads += 1)}`,
          op: "issue.comments",
          input: { id },
          context: asProject(who),
        });
      assert.deepEqual(typedOk(await notes(a, two.id)), { records: [] });
      for (const [who, name] of [
        [a, "a"],
        [b, "b"],
      ] as const)
        typedOk(
          await typedCall(who, {
            requestId: `typed-notes-write-${name}`,
            op: "issue.comment",
            input: { id: two.id, body: `from ${name}` },
            context: asProject(who),
          }),
        );
      const before = await dumpOf(typedProject);
      const stored = recordsOf(
        before,
        "forge/work",
        `comment:${storedOf(two.id)}:`,
      )
        .map(
          (row) =>
            JSON.parse(String(row.body)) as {
              key: string;
              value: { body: string };
            },
        )
        .sort(
          (x, y) => Number(x.key.split(":")[2]) - Number(y.key.split(":")[2]),
        );
      assert.equal(stored.length, 2);
      for (const who of [a, b, c])
        assert.deepEqual(typedOk(await notes(who, two.id)), {
          records: stored,
        });
      assert.deepEqual(
        stored.map((r) => r.value.body),
        ["from a", "from b"],
      );
      const missing = `${two.id.replace(/-.*/, "").toUpperCase()}-99999`;
      const gone = await notes(a, missing);
      typedFail(gone, 404, "NOT_FOUND");
      assert.equal(gone.body.error?.message, `Issue ${missing} was not found`);
      assert.deepEqual(await dumpOf(typedProject), before, "a read wrote");
    },
  );

  await typed(
    "typed fault: a failed receipt insert rolls a create back, and a retry creates exactly one issue",
    async () => {
      const create: Call = {
        requestId: "typed-fault-create",
        op: "issue.create",
        input: { title: "Third" },
        context: asProject(a),
      };
      const snapshot = await rolledBack(a, create);
      third = typedOk<Item>(await typedCall(a, create));
      const after = await dumpOf(typedProject);
      assert.equal(
        recordsOf(after, "forge/work", "issue:").length,
        recordsOf(snapshot, "forge/work", "issue:").length + 1,
      );
      assert.equal(
        recordsOf(after, "forge/cloud", "request:typed-fault-create").length,
        1,
      );
      assert.deepEqual(typedOk<Item>(await typedCall(a, create)), third);
    },
  );

  await typed(
    "typed fault: a failed receipt insert rolls a claim back, and a retry takes exactly one lease",
    async () => {
      const claimThird = claimOf("typed-fault-claim", a, third.id);
      await rolledBack(a, claimThird);
      assert.equal(
        typedOk<Grant>(await typedCall(a, claimThird)).generation,
        1,
      );
      const after = await dumpOf(typedProject);
      assert.equal(
        (after.tables.state_leases ?? []).filter(
          (row) => row.subject === `issue:${storedOf(third.id)}`,
        ).length,
        1,
      );
      assert.equal(
        recordsOf(after, "forge/cloud", "request:typed-fault-claim").length,
        1,
      );
      assert.deepEqual(await idsOf(a, "issue.ready"), [one.id]);
    },
  );

  // The third issue is held by a at generation 1; the first is open, unblocked and unleased. A
  // dependency of the third on the first blocks the third. The cloud refuses to claim a blocked issue,
  // so the stale one is the first: a one second claim that expires unreleased.
  await typed(
    "typed blocked and stale: an open dependency blocks the third, an expired unreleased lease makes the first stale, and the reads write nothing",
    async () => {
      assert.deepEqual(await idsOf(a, "issue.blocked"), []);
      assert.deepEqual(await idsOf(a, "issue.stale"), []);
      const held = await show(a, third.id);
      typedOk(
        await typedCall(a, {
          requestId: "typed-blocked-dep",
          op: "issue.dep",
          input: {
            id: third.id,
            target: one.id,
            action: "add",
            expectRevision: held.revision,
          },
          context: asHolder(a, 1),
        }),
      );
      assert.deepEqual(await idsOf(a, "issue.blocked"), [third.id]);
      assert.deepEqual(await idsOf(a, "issue.stale"), []);
      typedOk<Grant>(
        await typedCall(a, {
          requestId: "typed-stale-claim",
          op: "issue.claim",
          input: { id: one.id, ttlSeconds: 1 },
          context: asClaimer(a),
        }),
      );
      await sleep(1500);
      const before = await dumpOf(typedProject);
      // The first issue's lease expired unreleased; it is still unblocked, and the third is still held.
      assert.deepEqual(await idsOf(a, "issue.stale"), [one.id]);
      assert.deepEqual(await idsOf(a, "issue.blocked"), [third.id]);
      assert.deepEqual(await dumpOf(typedProject), before, "a read wrote");
    },
  );

  await typed(
    "typed dump and restore: the typed receipts restore with the issues, read back identical",
    async () => {
      const source = await dumpOf(typedProject);
      const target = `${run}-typed-restore`;
      // A restore refuses a provisioned target, and nothing here has issued it a token.
      assert.equal(await initialized(target), false);
      const restored = await adminCall(
        target,
        "POST",
        "restore",
        JSON.stringify(source),
      );
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      const copy = await dumpOf(target);
      assert.deepEqual(copy, source, "read back identical");
      const receipts = (
        "create-1 create-2 comment-1 claim-1 update-1 renew-1 release-1 " +
        "claim-2 dep-1 close-1 fault-create fault-claim"
      )
        .split(" ")
        .map((name) => `typed-${name}`);
      for (const dump of [source, copy]) {
        assert.equal(recordsOf(dump, "forge/work", "issue:").length, 3);
        assert.deepEqual(commentsOn(dump, one.id), [
          { id: storedOf(one.id), body: "first note" },
        ]);
        for (const requestId of receipts)
          assert.equal(
            recordsOf(dump, "forge/cloud", `request:${requestId}`).length,
            1,
            requestId,
          );
        // Typed receipts live in state_records, never in the raw routes' table.
        assert.deepEqual(
          (dump.tables.domain_cloud_requests ?? []).filter((row) =>
            String(row.request_id).startsWith("typed-"),
          ),
          [],
        );
      }
      // Tokens are not in a dump, and the restored project is not the admitted one.
      const refusedHere = await typedCall(a, createOne, {}, target);
      assert.equal(refusedHere.status, 403, JSON.stringify(refusedHere.body));
      assert.equal(refusedHere.body.error?.code, "AUTH_FORBIDDEN");
    },
  );

  await typed("typed state is saved for the restart phase", async () => {
    typedSaved = {
      caller: a,
      create: { ...createOne, context: asProject(a) },
      created,
      latest: await Promise.all(
        [one, two, third].map((item) => show(a, item.id)),
      ),
      ready: await idsOf(a, "issue.ready"),
      dump: await dumpOf(typedProject),
    };
  });

  await deviceChecks();

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
    JSON.stringify({
      project,
      holder,
      claimed,
      freed,
      revoked: revokedPhone,
      typed: typedSaved,
    }),
  );
  console.log(`saved restart state for ${project}`);
} else if (phase === "restart") {
  const saved = JSON.parse(readFileSync(stateFile, "utf8")) as {
    project: string;
    holder: Holder;
    claimed: Lease;
    freed: Lease;
    revoked: Device;
    typed?: TypedSaved;
  };
  await (live ? skip : check)(
    "typed replay, show, list and ready survive a restart, and add no row",
    async () => {
      const kept = saved.typed;
      assert.ok(kept, "the main phase saved the typed state");
      // The original create envelope, resent by the same actor and device, returns the recorded result.
      assert.deepEqual(
        typedOk<Item>(await typedCall(kept.caller, kept.create)),
        kept.created,
      );
      for (const item of kept.latest)
        assert.deepEqual(await show(kept.caller, item.id), item);
      assert.deepEqual(
        await idsOf(kept.caller, "issue.list"),
        kept.latest.map((item) => item.id).sort(),
      );
      assert.deepEqual(await idsOf(kept.caller, "issue.ready"), kept.ready);
      // Neither the replay nor any read wrote an issue, comment, receipt, event or lease.
      assert.deepEqual(await dumpOf(typedProject), kept.dump);
    },
  );
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
