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
  readonly ok?: boolean;
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
// A restore into an empty project derives the issue number floor when the dump has none. These sources hold
// only leases, so the derived floor is 0 and the target holds exactly one extra record and one extra event: the
// floor at 0, revision 1, written by the restore as the last event. This checks that pair, then strips it, so
// the rest of the target can be compared with the source row for row.
function settled(dump: Dump): Dump {
  const records = dump.tables.state_records ?? [];
  const events = dump.tables.state_events ?? [];
  const floors = recordsOf(dump, "forge/work", "allocation:issue:work-");
  assert.equal(floors.length, 1, "the restore derived one floor record");
  const floor = JSON.parse(String(floors[0]!.body)) as {
    value: unknown;
    revision: number;
    updatedAt: string;
    updatedBy: unknown;
  };
  assert.deepEqual(floor.value, { prefix: "issue:work-", number: 0 });
  assert.equal(floor.revision, 1);
  assert.deepEqual(floor.updatedBy, { kind: "agent", id: "cloud-restore" });
  const last = events.at(-1)!;
  assert.equal(last.sequence, events.length, "the floor event is the last");
  const written = JSON.parse(String(last.body)) as {
    key: string;
    revision: number;
    at: string;
    actor: unknown;
    data: unknown;
  };
  assert.deepEqual(
    [written.key, written.revision, written.actor, written.data, written.at],
    [
      "allocation:issue:work-",
      1,
      { kind: "agent", id: "cloud-restore" },
      { prefix: "issue:work-", number: 0 },
      floor.updatedAt,
    ],
    "the last event writes the floor record",
  );
  return {
    ...dump,
    tables: {
      ...dump.tables,
      state_records: records.filter((row) => row !== floors[0]),
      state_events: events.slice(0, -1),
    },
  };
}
// The rows of a paged export as one dump, so they compare with a whole export.
function joined(pages: readonly DumpPage[]): Dump {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const page of pages)
    for (const [table, rows] of Object.entries(page.tables))
      (tables[table] ??= []).push(...rows);
  return { format: "forge-cloud-dump/1", tables };
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

// Budget journeys (forge-1304): real exported pages restored through the Worker and compared exactly. A second
// argument names one journey, or a prefix of its name, so a counterfactual runs only the journey it targets.
const only = process.argv[3];
// A journey may also name a deadline in milliseconds: past it the journey fails by name instead of hanging the job.
async function journey(
  name: string,
  body: () => Promise<void>,
  deadline?: number,
): Promise<void> {
  if (only !== undefined && !name.startsWith(only)) return;
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await check(
    name,
    deadline === undefined
      ? body
      : () =>
          Promise.race([
            body(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`no result within ${deadline} ms`)),
                deadline,
              );
            }),
          ]).finally(() => clearTimeout(timer)),
  );
  console.log(`INFO ${name}: ${Math.round(performance.now() - started)} ms`);
}
const showDigests = (label: string, digests: Record<string, string>): void =>
  console.log(
    `INFO ${label} tables: ${Object.entries(digests)
      .map(([table, digest]) => `${table} ${digest.slice(0, 26)}`)
      .join("; ")}`,
  );
function okValue<T>(
  reply: { status: number; body: AdminBody },
  what: string,
): T {
  assert.equal(
    reply.status,
    200,
    `${what}: ${JSON.stringify(reply.body).slice(0, 300)}`,
  );
  assert.equal(reply.body.ok, true, `${what} is not ok`);
  return reply.body.value as T;
}
// The real export of `project`: GET dump?cursor=start, then only the cursor each page returns, URL-encoded, until next
// is null. `each` sees every page once and nothing is kept after it. Each page is serialized once, and its UTF-8 bytes
// are measured on that text; the page document, not the HTTP envelope, is what the budget bounds.
async function walk(
  project: string,
  label: string,
  budget: number,
  each: (page: DumpPage, text: string) => Promise<void> | void,
): Promise<{ bytes: number[]; urls: number[] }> {
  const trip = { bytes: [] as number[], urls: [] as number[] };
  const seen = new Set<string>();
  let cursor = "start";
  for (;;) {
    assert.ok(!seen.has(cursor), `${label}: a cursor repeats`);
    assert.ok(seen.size < 32, `${label}: the export does not end`);
    seen.add(cursor);
    const route = `dump?cursor=${encodeURIComponent(cursor)}`;
    trip.urls.push(Buffer.byteLength(`${base}/p/${project}/${route}`));
    const page = okValue<DumpPage>(
      await adminCall(project, "GET", route),
      `${label} export`,
    );
    const text = JSON.stringify(page);
    const bytes = Buffer.byteLength(text);
    trip.bytes.push(bytes);
    assert.ok(
      bytes <= budget,
      `page ${page.page} is ${bytes} bytes, over the ${budget} byte budget`,
    );
    assert.equal(page.format, "forge-cloud-dump-page/1");
    assert.equal(page.page, trip.bytes.length - 1, `${label}: page numbers`);
    assert.equal(page.last, page.next === null, `${label}: last means no next`);
    await each(page, text);
    if (page.next === null) return trip;
    cursor = page.next;
  }
}
// Every real page of `source` goes unchanged and in order into the empty `target`, which is then read back page by
// page. Digests of every column of every row stand in for copies, so one page is held at a time.
async function roundTrip(
  source: string,
  target: string,
  label: string,
  budget: number,
  each: (page: DumpPage, text: string) => void = () => undefined,
) {
  const { digester } = await import("./budget.ts");
  const sent = digester();
  assert.equal(await initialized(target), false, `${label}: target is empty`);
  const trip = await walk(source, label, budget, async (page, text) => {
    each(page, text);
    const reply = okValue<{
      restored: Record<string, number>;
      page: number;
      done: boolean;
    }>(
      await adminCall(target, "POST", "restore", text),
      `${label} restore of page ${page.page}`,
    );
    assert.equal(reply.page, page.page, `${label}: page acknowledgement`);
    assert.equal(reply.done, page.last, `${label}: done only on the last page`);
    assert.deepEqual(
      reply.restored,
      Object.fromEntries(
        Object.entries(page.tables).map(([table, rows]) => [
          table,
          rows.length,
        ]),
      ),
      `${label}: restored counts of page ${page.page}`,
    );
    assert.equal(
      await initialized(target),
      page.last,
      `${label}: provisioned only after the last page`,
    );
    for (const [table, rows] of Object.entries(page.tables))
      sent.add(table, rows);
  });
  const back = digester();
  const read = await walk(target, `${label} readback`, budget, (page) => {
    for (const [table, rows] of Object.entries(page.tables))
      back.add(table, rows);
  });
  const digests = sent.done();
  assert.deepEqual(
    back.done(),
    digests,
    `${label}: target differs from source`,
  );
  assert.deepEqual(read.bytes, trip.bytes, `${label}: target pages differ`);
  return { ...trip, digests };
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
      ip?: string,
      converge?: string,
    ) => {
      const state =
        new URL(decision.headers.get("location") ?? "").searchParams.get("s") ??
        "";
      const query = new URLSearchParams({
        state,
        code: "owner",
      });
      return call(`/callback?${query}`, {
        cookie,
        fault,
        ...(ip === undefined ? {} : { ip }),
        ...(converge === undefined ? {} : { converge }),
      });
    };
    // An unknown callback state from its own address: a guess that spends the address and project only.
    const guess = () =>
      call(
        `/callback?${new URLSearchParams({ state: `forge-device.${crypto.randomUUID()}`, code: "owner" })}`,
      );
    const poll = (f: Flow) =>
      call(`/p/${typedProject}/loginpoll`, {
        json: { device_code: f.deviceCode },
      });
    return { previewed, decide, bindOf, back, guess, poll };
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

  // The journeys below share the project's 30 guesses a minute, so each spends only what it must: the
  // address journey runs both actions on one exhausted address, and the rest need one challenge each.
  for (const action of ["approve", "deny"] as const) {
    await device(
      `device: the sixth attempt for one challenge, from another address, is rate limited (${action})`,
      async () => {
        const f = await browser.previewed();
        for (let n = 0; n < 5; n++)
          assert.deepEqual(outcomeOf(await browser.decide(f, action, WRONG)), [
            400,
            "invalid_request",
          ]);
        const sixth = await browser.decide(f, action, WRONG);
        assert.deepEqual(outcomeOf(sixth), [429, "rate_limited"]);
        // The right ticket is a bound proof: it needs no wait, and its callback is no guess either.
        const decision = await browser.decide(f, action, f.ticket(action));
        assert.equal(decision.status, 302, decision.text);
        const own = browser.bindOf(decision);
        const wrongBrowser = await browser.back(
          decision,
          `${own.split("=")[0]}=${WRONG}`,
        );
        assert.deepEqual(outcomeOf(wrongBrowser), [429, "rate_limited"]);
        const done = await browser.back(decision, own);
        assert.deepEqual(outcomeOf(done), [
          200,
          action === "approve" ? "approved" : "denied",
        ]);
      },
    );
  }

  await device(
    "device: the sixth attempt from one address is rate limited, whatever the challenge",
    async () => {
      const ip = "198.51.100.9";
      for (let n = 0; n < 5; n++) {
        const f = await browser.previewed();
        const reply = await browser.decide(f, "approve", WRONG, { ip });
        assert.deepEqual(outcomeOf(reply), [400, "invalid_request"]);
      }
      for (const action of ["approve", "deny"] as const) {
        const f = await browser.previewed();
        const sixth = await browser.decide(f, action, WRONG, { ip });
        assert.deepEqual(outcomeOf(sixth), [429, "rate_limited"]);
        // The right ticket from that address is a bound proof: no wait, and its callback finishes too.
        const decision = await browser.decide(f, action, f.ticket(action), {
          ip,
        });
        assert.equal(decision.status, 302, decision.text);
        const done = await browser.back(
          decision,
          browser.bindOf(decision),
          false,
          ip,
        );
        assert.deepEqual(outcomeOf(done), [
          200,
          action === "approve" ? "approved" : "denied",
        ]);
      }
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
      // The challenge is now full. The same right ticket twice at once decides once; the loser is an
      // ordinary refused guess, never a second redirect.
      const ticket = f.ticket("approve");
      const twice = await Promise.all(
        Array.from({ length: 2 }, () =>
          browser.decide(f, "approve", ticket, {
            converge: `overlap-ticket-${run}:2`,
          }),
        ),
      );
      assert.deepEqual(
        twice.map((reply) => reply.status).sort(),
        [302, 429],
        JSON.stringify(twice.map((reply) => reply.text.slice(0, 120))),
      );
      // The same right state twice at once finishes once; the other is refused, not a second decision.
      const won = twice.find((reply) => reply.status === 302)!;
      const own = browser.bindOf(won);
      const back = await Promise.all(
        Array.from({ length: 2 }, () =>
          browser.back(won, own, false, undefined, `overlap-state-${run}:2`),
        ),
      );
      const detail = JSON.stringify(
        back.map((reply) => reply.text.slice(0, 120)),
      );
      assert.equal(
        back.filter((reply) => reply.status === 200).length,
        1,
        detail,
      );
      assert.ok(
        back.every((reply) => [200, 400, 429].includes(reply.status)),
        detail,
      );
      // One redemption: the polling device gets one credential, once.
      assert.equal((await browser.poll(f)).status, 200);
      assert.equal((await browser.poll(f)).status, 400);
    },
  );

  // Last, because it leaves the project's guess budget full for the rest of its minute. Guesses from
  // distinct addresses fill it, however much earlier journeys already spent; both completions then follow
  // at once, the second after its decision was made before the budget filled.
  for (const action of ["approve", "deny"] as const) {
    await device(
      `device ${action}: bound proofs finish while the project guess budget is full`,
      async () => {
        const fill = async () => {
          for (let n = 0; n < 31; n++) {
            const reply = await browser.guess();
            if (reply.status === 429) return;
            assert.deepEqual(outcomeOf(reply), [400, "access_denied"]);
          }
          assert.fail("the project guess budget never filled");
        };
        const word = action === "approve" ? "approved" : "denied";
        const a = await browser.previewed();
        await fill();
        const decision = await browser.decide(a, action, a.ticket(action));
        assert.equal(decision.status, 302, decision.text);
        assert.deepEqual(outcomeOf(await browser.decide(a, action, WRONG)), [
          429,
          "rate_limited",
        ]);
        const done = await browser.back(decision, browser.bindOf(decision));
        assert.deepEqual(outcomeOf(done), [200, word]);
        const b = await browser.previewed();
        const early = await browser.decide(b, action, b.ticket(action));
        assert.equal(early.status, 302, early.text);
        await fill();
        const late = await browser.back(early, browser.bindOf(early));
        assert.deepEqual(outcomeOf(late), [200, word]);
        assert.equal(
          (await browser.poll(b)).status,
          action === "approve" ? 200 : 400,
        );
      },
    );
  }
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
      assert.deepEqual(
        settled(await dumpOf(target)),
        dump,
        "read back identical",
      );
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
      assert.deepEqual(
        settled(await dumpOf(target)),
        dump,
        "read back identical",
      );
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
      assert.deepEqual(
        settled(await dumpOf(target)),
        whole,
        "read back identical",
      );
      // The generated pair moves the page edges, so the pages compare as rows.
      assert.deepEqual(
        settled(joined(await pagesOf(target))),
        whole,
        "same rows in pages",
      );
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
      assert.deepEqual(settled(await dumpOf(target)), await dumpOf(source));

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
      assert.deepEqual(settled(await dumpOf(target)), await dumpOf(race));
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
    "a restore with duplicate JSON labels is refused as RESTORE_INVALID_ROW and writes nothing",
    async () => {
      // A real valid dump from the in-process source: its records are the receipt, the floor and the issue, so
      // with one row per page the floor record and its event fall after page 0.
      const { leaseSource, pagesOf: cutRows } = await import("./max-source.ts");
      const { doc } = await leaseSource("issue:dupl-1");
      const dump = doc as Dump;
      const pages = cutRows(doc.tables, 1) as unknown as DumpPage[];
      assert.ok(pages.length >= 8, `${pages.length} pages`);
      const floor = "allocation:issue:work-";
      const repeat = (from: string, to: string) => (text: string) =>
        text.replace(from, to);
      const generation = repeat(
        '"generation":',
        '"generation":9,"generation":',
      );
      type Row = Record<string, unknown>;
      // [name, table, which row, column, the edit]; the last value of the label is always the original.
      const cases: [
        string,
        string,
        (row: Row) => boolean,
        string,
        (text: string) => string,
      ][] = [
        [
          "event type",
          "state_events",
          (row) => row.key === floor,
          "body",
          repeat('"type":', '"type":"ignored","type":'),
        ],
        [
          "record body",
          "state_records",
          (row) => row.key === floor,
          "body",
          repeat('"key":', '"key":"other","key":'),
        ],
        [
          "event nested label",
          "state_events",
          (row) => row.key === floor,
          "body",
          repeat('"number":', '"number":9,"number":'),
        ],
        [
          "event nested label spelled with an escape",
          "state_events",
          (row) => row.key === floor,
          "body",
          (text) =>
            text.replace(
              /"number":(\d+)/,
              (_match, value: string) =>
                `"\\u006eumber":${value},"number":${value}`,
            ),
        ],
        [
          "record nested label",
          "state_records",
          (row) => row.key === floor,
          "body",
          repeat('"number":', '"number":9,"number":'),
        ],
        ["lease body", "state_leases", () => true, "body", generation],
        [
          "owner receipt result",
          "state_requests",
          (row) => String(row.result).includes('"generation":'),
          "result",
          generation,
        ],
        [
          "server receipt result",
          "domain_cloud_requests",
          (row) => row.outcome === "ok",
          "result",
          generation,
        ],
      ];
      const named = (table: string, row: Row): string =>
        table === "domain_cloud_requests"
          ? String(row.request_id)
          : JSON.stringify([
              row.namespace,
              row[
                table === "state_leases"
                  ? "subject"
                  : table === "state_requests"
                    ? "request_id"
                    : "key"
              ],
            ]);
      const empty = async (project: string, label: string): Promise<void> => {
        assert.equal(await initialized(project), false, label);
        for (const rows of Object.values((await dumpOf(project)).tables))
          assert.equal(rows.length, 0, `${label}: nothing was written`);
      };
      const refusal = (
        reply: Awaited<ReturnType<typeof adminCall>>,
        label: string,
        table: string,
        row: Row,
        repeated: string,
      ): void => {
        assert.equal(
          reply.status,
          400,
          `${label}: ${JSON.stringify(reply.body)}`,
        );
        assert.equal(reply.body.error?.code, "RESTORE_INVALID_ROW", label);
        assert.equal(
          reply.body.error?.message,
          `${table} row ${named(table, row)} is not valid state`,
          label,
        );
        assert.ok(
          !String(reply.body.error?.message).includes(repeated),
          `${label}: the refusal holds no body`,
        );
      };
      for (const [
        index,
        [name, table, pick, column, edit],
      ] of cases.entries()) {
        // Whole: nothing is written, and the same dump with the label restored to one restores in place.
        const whole = JSON.parse(JSON.stringify(dump)) as Dump;
        const row = whole.tables[table]!.find(pick) as Row;
        const original = String(row[column]);
        const repeated = edit(original);
        assert.notEqual(repeated, original, name);
        assert.deepEqual(JSON.parse(repeated), JSON.parse(original), name);
        row[column] = repeated;
        const target = `${run}-dupl-whole-${index}`;
        refusal(
          await adminCall(target, "POST", "restore", JSON.stringify(whole)),
          `whole ${name}`,
          table,
          row,
          repeated,
        );
        await empty(target, `whole ${name}`);
        const clean = await adminCall(
          target,
          "POST",
          "restore",
          JSON.stringify(dump),
        );
        assert.equal(clean.status, 200, JSON.stringify(clean.body));
        assert.deepEqual(await dumpOf(target), dump, `whole ${name}: retry`);

        // Paged: every page before the last is staged, the last refuses, and nothing stays staged.
        const copy = JSON.parse(JSON.stringify(pages)) as DumpPage[];
        const at = copy.findIndex((page) => page.tables[table]!.some(pick));
        // After page 0 and before the last page; a server receipt is in the last table, so it may be on the last.
        const end =
          table === "domain_cloud_requests" ? copy.length : copy.length - 1;
        assert.ok(at > 0 && at < end, `${name}: page ${at} of ${copy.length}`);
        const staged = copy[at]!.tables[table]!.find(pick) as Row;
        staged[column] = edit(String(staged[column]));
        const paged = `${run}-dupl-paged-${index}`;
        for (const page of copy) {
          const reply = await sendPage(paged, page);
          if (!page.last) {
            assert.equal(reply.status, 200, JSON.stringify(reply.body));
            continue;
          }
          refusal(reply, `paged ${name}`, table, staged, repeated);
        }
        await empty(paged, `paged ${name}`);
        assert.equal(
          (await sendPage(paged, pages[1])).status,
          400,
          `paged ${name}: abandoned`,
        );
        for (const page of pages)
          assert.equal((await sendPage(paged, page)).status, 200);
        assert.deepEqual(await dumpOf(paged), dump, `paged ${name}: retry`);
      }
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
      // forge-1311: the admitted project starts as a restored legacy project: only a deleted work-2, no floor.
      const legacyAt = "2026-01-01T00:00:00.000Z";
      const legacyActor = { kind: "agent", id: "legacy" };
      const legacyEvents = [
        {
          type: "forge/work:record.updated@1",
          namespace: "forge/work",
          key: "issue:work-2",
          revision: 1,
          at: legacyAt,
          actor: legacyActor,
          data: {
            id: "work-2",
            prefix: "ci",
            title: "Old",
            status: "open",
            labels: [],
            dependsOn: [],
            createdAt: legacyAt,
          },
        },
        {
          type: "forge/work:record.deleted@1",
          namespace: "forge/work",
          key: "issue:work-2",
          revision: 2,
          at: legacyAt,
          actor: legacyActor,
        },
      ].map((event, index) => ({
        sequence: index + 1,
        namespace: "forge/work",
        key: "issue:work-2",
        body: JSON.stringify(event),
      }));
      const restored = await adminCall(
        typedProject,
        "POST",
        "restore",
        JSON.stringify({
          format: "forge-cloud-dump/1",
          tables: {
            state_records: [],
            state_events: legacyEvents,
            state_leases: [],
            state_requests: [],
            domain_cloud_requests: [],
          },
        }),
      );
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      // Issuing the first token provisions the admitted project.
      a = await callerFor("a");
      b = await callerFor("b");
      c = await callerFor("c", false);
      created = typedOk<Item>(
        await typedCall(a, { ...createOne, context: asProject(a) }),
      );
      // The saved floor is 2, so the first create is 3 at revision 1, and the deleted 2 is never reused.
      assert.equal(created.id, "ci-3");
      assert.equal(created.status, "open");
      assert.equal(created.revision, 1);
      const restoredDump = await dumpOf(typedProject);
      const floorRows = recordsOf(
        restoredDump,
        "forge/work",
        "allocation:issue:work-",
      );
      assert.equal(floorRows.length, 1);
      assert.equal(floorRows[0]!.revision, 2);
      assert.deepEqual(
        (JSON.parse(String(floorRows[0]!.body)) as { value: unknown }).value,
        { prefix: "issue:work-", number: 3 },
      );
      const keptEvents = restoredDump.tables.state_events!;
      assert.deepEqual(
        keptEvents.slice(0, 2).map((row) => row.body),
        legacyEvents.map((row) => row.body),
        "the legacy events are unchanged",
      );
      const floorEvent = JSON.parse(String(keptEvents[2]!.body)) as {
        key: string;
        revision: number;
        actor: unknown;
        data: unknown;
      };
      assert.deepEqual(
        [floorEvent.key, floorEvent.revision, floorEvent.data],
        ["allocation:issue:work-", 1, { prefix: "issue:work-", number: 2 }],
        "the restore wrote the floor at 2 and the create advanced it",
      );
      assert.deepEqual(floorEvent.actor, {
        kind: "agent",
        id: "cloud-restore",
      });
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
      // Two work events (forge-1306): the link and the first move of its issue's link floor, which is the one new
      // floor record and holds the number the link took.
      assert.equal(
        eventsIn(after, "forge/work"),
        eventsIn(before, "forge/work") + 2,
      );
      assert.deepEqual(
        recordsOf(
          after,
          "forge/work",
          `allocation:link:${storedOf(one.id)}:`,
        ).map(
          (row) => (JSON.parse(String(row.body)) as { value: unknown }).value,
        ),
        [{ prefix: `link:${storedOf(one.id)}:`, number: 1 }],
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

if (phase === "large") {
  // The largest legal project through the real Worker at its default limits (4 MiB pages, 8 MiB project, no
  // small test caps; see the large step in .github/workflows/cloud.yml). The restore input is the rows of an
  // in-process project read with plain SQL, never an export, so a restore case reaches the parser even while
  // export is broken. That project is named like the admitted target and acts as the same device and actor,
  // so a replay on the restored target carries the fingerprints that made each receipt.
  const {
    ACTOR,
    BODY,
    WIDE,
    call: commandOf,
    maxSource,
    pagesOf: cut,
    tablesOf,
  } = await import("./max-source.ts");
  const oracle = await import("./budget.ts");
  assert.notEqual(
    typedProject,
    "",
    "FORGE_CLOUD_PROJECT names the admitted target",
  );
  const prefix = process.env.FORGE_CLOUD_ID_PREFIX ?? "ci";
  const id = `${prefix}-1`;
  const source = await maxSource(typedProject, prefix);
  const want = source.tables;
  const differing = (got: Dump["tables"]): string[] =>
    Object.keys(want).filter(
      (table) => JSON.stringify(got[table]) !== JSON.stringify(want[table]),
    );
  const shortly = (body: unknown): string => JSON.stringify(body).slice(0, 300);
  const pagedTarget = `${run}-large-paged`;
  let laptop: Promise<Caller> | undefined;
  const who = (): Promise<Caller> =>
    (laptop ??= issue(typedProject, "laptop", undefined, false).then(
      (device) => ({ device, actor: ACTOR, session: "unbound" }),
    ));

  await check(
    "large whole restore: the maximum project restores into a fresh target and reads back exactly",
    async () => {
      assert.equal(await initialized(typedProject), false);
      const reply = await adminCall(
        typedProject,
        "POST",
        "restore",
        JSON.stringify(source.doc),
      );
      assert.equal(reply.status, 200, shortly(reply.body));
      assert.deepEqual(differing((await dumpOf(typedProject)).tables), []);
    },
  );
  await check(
    "large paged restore: independent pages in order, done only on the last, unprovisioned until then",
    async () => {
      const parts = cut(want, 2);
      for (const [i, part] of parts.entries()) {
        const reply = await adminCall(
          pagedTarget,
          "POST",
          "restore",
          JSON.stringify(part),
        );
        assert.equal(reply.status, 200, shortly(reply.body));
        const last = i === parts.length - 1;
        assert.equal((reply.body.value as { done: boolean }).done, last);
        assert.equal(await initialized(pagedTarget), last);
      }
      assert.deepEqual(differing((await dumpOf(pagedTarget)).tables), []);
    },
  );
  await check(
    "large restored target: show and comments return the originals in full",
    async () => {
      const caller = await who();
      assert.equal((await show(caller, id)).body === BODY, true);
      const { records } = await typedRead<{
        records: { value: { body: string } }[];
      }>(caller, "issue.comments", { id });
      assert.deepEqual(
        records.map((record) => record.value.body === BODY),
        [true],
      );
    },
  );
  await check(
    "large restored target: accepted and refused requests replay unchanged and write nothing",
    async () => {
      const caller = await who();
      for (const [name, sent] of Object.entries(source.sent)) {
        const reply = await typedCall(caller, sent.request as Call);
        assert.equal(reply.status, sent.status, name);
        assert.equal(JSON.stringify(reply.body) === sent.text, true, name);
      }
      assert.deepEqual(
        differing((await dumpOf(typedProject)).tables),
        [],
        "a replay wrote",
      );
    },
  );
  await check(
    "large restored target: fresh commands write on top of the restored rows",
    async () => {
      const caller = await who();
      // The restored issue is there to be written on top of: on a failed restore this read is NOT_FOUND.
      assert.equal((await show(caller, id)).body === BODY, true);
      typedOk(
        await typedCall(caller, {
          requestId: "large-fresh-comment",
          op: "issue.comment",
          input: { id, body: "later" },
          context: asProject(caller),
        }),
      );
      // Two more maximum issues grow the project past one 4 MiB page, and still under its 8 MiB.
      for (const n of [1, 2])
        typedOk(
          await typedCall(caller, {
            requestId: `large-grow-${n}`,
            op: "issue.create",
            input: { title: `Grown ${n}`, body: BODY },
            context: asProject(caller),
          }),
        );
      // The comment is the second one on the restored issue, after the restored first.
      const { records } = await typedRead<{ records: unknown[] }>(
        caller,
        "issue.comments",
        { id },
      );
      assert.equal(records.length, 2);
    },
  );
  await check(
    "large paged export: consecutive pages, each complete page within 4 MiB, no row lost",
    async () => {
      const pages = await pagesOf(typedProject);
      assert.ok(pages.length > 1, "the grown project crosses a page");
      const merged: Record<string, Record<string, unknown>[]> =
        Object.fromEntries(Object.keys(want).map((table) => [table, []]));
      for (const [n, page] of pages.entries()) {
        assert.equal(page.page, n);
        assert.ok(
          Buffer.byteLength(JSON.stringify(page)) <= 4 * 1024 * 1024,
          `page ${n} is over 4 MiB`,
        );
        for (const [table, rows] of Object.entries(page.tables))
          merged[table]!.push(...rows);
      }
      // Two floors advance in place and are replaced, not added. The two grown creates move the issue floor
      // from number 1, revision 1 to number 3, revision 3. The fresh comment moves the restored issue's comment
      // floor from number 1, revision 1 to number 2, revision 2. Every other row of the source is unchanged.
      const floorKeys = new Map([
        [
          "allocation:issue:work-",
          { prefix: "issue:work-", number: 3, revision: 3 },
        ],
        [
          `allocation:comment:${storedOf(id)}:`,
          { prefix: `comment:${storedOf(id)}:`, number: 2, revision: 2 },
        ],
      ]);
      const floor = (row: Record<string, unknown>) =>
        row.namespace === "forge/work" && floorKeys.has(String(row.key));
      for (const table of Object.keys(want)) {
        const have = new Set(merged[table]!.map((row) => JSON.stringify(row)));
        assert.ok(
          want[table]!.filter(
            (row) => table !== "state_records" || !floor(row),
          ).every((row) => have.has(JSON.stringify(row))),
          `${table} lost a row`,
        );
      }
      const floors = merged.state_records!.filter(floor);
      assert.equal(floors.length, floorKeys.size, "one row per floor");
      for (const [key, moved] of floorKeys) {
        const row = floors.find((candidate) => candidate.key === key);
        assert.equal(row?.revision, moved.revision, key);
        assert.deepEqual(
          (JSON.parse(String(row?.body)) as { value: unknown }).value,
          { prefix: moved.prefix, number: moved.number },
          key,
        );
      }
      // A comment and two issues joined, each with its receipt: six more records and six more events, and
      // three more events for the floors' three advances (the floor records were replaced, not added).
      assert.equal(
        merged.state_records!.length,
        want.state_records!.length + 6,
      );
      assert.equal(merged.state_events!.length, want.state_events!.length + 9);
    },
  );
  await journey(
    "budget maximum: real grown pages restore exactly",
    async () => {
      const budget = 4 * 1024 * 1024;
      const caller = await who();
      // Two more creates of three-byte text. The independent fixture grows by the same commands the Worker has
      // run (the fresh comment and two maximum creates), then these two, and the Worker is sent these two now.
      const wide = (n: number) =>
        commandOf(`large-wide-${n}`, "issue.create", {
          title: `Wide ${n}`,
          body: WIDE,
        });
      for (const request of [
        commandOf("large-fresh-comment", "issue.comment", {
          id,
          body: "later",
        }),
        ...[1, 2].map((n) =>
          commandOf(`large-grow-${n}`, "issue.create", {
            title: `Grown ${n}`,
            body: BODY,
          }),
        ),
        wide(1),
        wide(2),
      ])
        assert.equal(
          (await source.send(request)).status,
          200,
          request.requestId,
        );
      for (const n of [1, 2])
        typedOk(
          await typedCall(caller, { ...wide(n), context: asProject(caller) }),
        );
      const grown = tablesOf(source.db);
      const expected = oracle.cutPages(grown, budget);
      // The fixture must tell a UTF-16 count from a byte count: cut by units, a page overfills by real bytes.
      assert.ok(
        oracle
          .cutPages(grown, budget, oracle.utf16)
          .some((page) => oracle.utf8(page) > budget),
        "the grown fixture cannot tell a UTF-16 count from a UTF-8 byte count",
      );
      const stamped = oracle.digester(true);
      const trip = await roundTrip(
        typedProject,
        `${run}-large-journey`,
        "maximum",
        budget,
        (page) => {
          for (const [table, rows] of Object.entries(page.tables))
            stamped.add(table, rows);
        },
      );
      assert.ok(
        trip.bytes.length >= 2 && Math.max(...trip.bytes) >= 3 * 1024 * 1024,
        `the real pages are ${trip.bytes.join(", ")} bytes`,
      );
      assert.deepEqual(
        trip.bytes,
        expected.map((page) => oracle.utf8(page)),
        "the real pages are not the expected pages",
      );
      // Only the clock times differ from the fixture, which ran at another time; source to target is exact above.
      assert.deepEqual(
        stamped.done(),
        oracle.digestOf(grown, true),
        "the grown export differs from the independently grown project",
      );
      console.log(
        `INFO maximum: pages ${trip.bytes.join(", ")} bytes of ${budget}; mutated cut: ${oracle
          .cutPages(grown, budget, oracle.utf16)
          .map((page) => oracle.utf8(page))
          .join(", ")}`,
      );
      showDigests("maximum", trip.digests);
    },
  );
}

// forge-1306: comment and link numbers are never reused after a delete. The isolated "numbers" and "numbers-restart" runs
// (see .github/workflows/cloud.yml) share one fresh persistence directory and the default dump limits. The first Worker admits
// project *-a, the second admits *-b, because the typed /command route admits one project. The source is a legacy project
// built by the real state owner in this process and read with plain SQL; nothing here deletes through the Worker.
const numbersState = `${stateFile}.numbers`;
const NUMBERS_NAME =
  "comment and link numbers survive deleted history, restore and concurrent adds";
const NUMBERS_RESTART_NAME =
  "comment and link floors survive a restart, and later adds continue above them";
// The floors of the legacy source's families, as { key: [prefix, number, revision] }: work-1 holds comment and link
// history, work-2 has less, and work-3 only links, so it has no comment floor. `numbers` and `revisions` are in the
// order comment 1, comment 2, link 1, link 2, link 3; the issue floor is always 3 at revision 1.
const FAMILIES = [
  ["comment", 1],
  ["comment", 2],
  ["link", 1],
  ["link", 2],
  ["link", 3],
] as const;
const floorsFor = (
  numbers: readonly number[],
  revisions: readonly number[],
): Record<string, readonly [string, number, number]> =>
  // In key order, like floorsOf: the checks compare the serialized objects, so order is part of the match.
  Object.fromEntries(
    Object.entries({
      "allocation:issue:work-": ["issue:work-", 3, 1] as const,
      ...Object.fromEntries(
        FAMILIES.map(([kind, n], i) => [
          `allocation:${kind}:work-${n}:`,
          [`${kind}:work-${n}:`, numbers[i]!, revisions[i]!] as const,
        ]),
      ),
    }).sort(([x], [y]) => (x < y ? -1 : 1)),
  );
// What a restore derives: the highest number ever accepted (live or deleted) of each family, at revision 1.
const SETTLED = floorsFor([10, 5, 10, 3, 3], [1, 1, 1, 1, 1]);
// After the first typed adds and races, and after the restart's adds.
const AFTER_ADDS = floorsFor([13, 6, 13, 4, 4], [4, 2, 4, 2, 2]);
const AFTER_RESTART = floorsFor([14, 7, 14, 5, 4], [5, 3, 5, 3, 2]);
interface Numbered {
  readonly namespace: string;
  readonly key: string;
  readonly revision: number;
  readonly value: unknown;
  readonly updatedBy: { readonly id: string };
}
const same = (label: string, got: unknown, want: unknown): void => {
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  assert.ok(
    g === w,
    `${label}: got ${g?.slice(0, 500)}, want ${w?.slice(0, 500)}`,
  );
};
// The floor records of one project as { key: [prefix, number, revision] }, in key order.
const floorsOf = (
  dump: Dump,
): Record<string, readonly [string, number, number]> =>
  Object.fromEntries(
    recordsOf(dump, "forge/work", "allocation:").map((row) => {
      const floor = JSON.parse(String(row.body)) as Numbered & {
        value: { prefix: string; number: number };
      };
      return [
        String(row.key),
        [floor.value.prefix, floor.value.number, floor.revision],
      ];
    }),
  );
// The stored record at one work key, or null.
const storedAt = (dump: Dump, key: string): Numbered | null => {
  const text = recordsOf(dump, "forge/work", key)[0]?.body;
  return typeof text === "string" ? (JSON.parse(text) as Numbered) : null;
};
const ok = (reply: { status: number; body: unknown }): void =>
  assert.equal(reply.status, 200, JSON.stringify(reply.body).slice(0, 300));
const rowsIn = (
  dump: Dump,
  table: string,
): readonly Record<string, unknown>[] => dump.tables[table] ?? [];
// What one batch of writes changed between two whole dumps: records added or rewritten, and the work events appended.
function changes(before: Dump, after: Dump) {
  const named = (row: Record<string, unknown>) =>
    `${String(row.namespace)} ${String(row.key)}`;
  const had = new Map(
    rowsIn(before, "state_records").map((row) => [
      named(row),
      JSON.stringify(row),
    ]),
  );
  const added: string[] = [];
  const rewritten: string[] = [];
  for (const row of rowsIn(after, "state_records")) {
    const old = had.get(named(row));
    if (old === undefined) added.push(named(row));
    else if (old !== JSON.stringify(row)) rewritten.push(named(row));
  }
  const events = rowsIn(after, "state_events");
  const first = rowsIn(before, "state_events").length;
  return {
    added: added.sort(),
    rewritten: rewritten.sort(),
    kept: had.size + added.length === rowsIn(after, "state_records").length,
    oldEvents:
      JSON.stringify(events.slice(0, first)) ===
      JSON.stringify(rowsIn(before, "state_events")),
    workEvents: events
      .slice(first)
      .filter((row) => row.namespace === "forge/work")
      .map(
        (row) =>
          `forge/work ${(JSON.parse(String(row.body)) as { key: string }).key}`,
      )
      .sort(),
  };
}
// One typed write: the stored key it reports, or the refusal it got instead, and its result as returned.
async function landed(who: Caller, call: Call) {
  const reply = await typedCall(who, call);
  const result = reply.body.result as
    { commentId?: string; key?: string } | undefined;
  return {
    got:
      reply.status === 200
        ? (result?.commentId ?? result?.key ?? "no key")
        : `HTTP ${reply.status} ${reply.body.error?.code}`,
    result,
  };
}
const noteCall = (who: Caller, requestId: string, id: string): Call => ({
  requestId,
  op: "issue.comment",
  input: { id, body: `Note ${requestId}` },
  context: asProject(who),
});
const linkCall = (
  who: Caller,
  generation: number,
  requestId: string,
  id: string,
): Call => ({
  requestId,
  op: "issue.link",
  input: { id, relation: "delivers", url: `https://example.com/${requestId}` },
  context: asHolder(who, generation),
});
const suffixesOf = (result: unknown): number[] =>
  (result as { records: { key: string }[] }).records.map((record) =>
    Number(record.key.split(":")[2]),
  );
// A whole dump or a joined export as comparable text: the five tables in dump order, however the object lists them.
const TABLES = [
  "state_records",
  "state_events",
  "state_leases",
  "state_requests",
  "domain_cloud_requests",
] as const;
const nameOf = (dump: Dump) =>
  JSON.stringify(TABLES.map((table) => rowsIn(dump, table)));

if (phase === "numbers") {
  const { numberSource, pagesOf: cut } = await import("./max-source.ts");
  assert.notEqual(
    typedProject,
    "",
    "FORGE_CLOUD_PROJECT names the admitted project",
  );
  const prefix = process.env.FORGE_CLOUD_ID_PREFIX ?? "ci";
  const second = typedProject.replace(/a$/, "b");
  assert.notEqual(second, typedProject, "FORGE_CLOUD_PROJECT must end in a");
  const [pagedTarget, joinedTarget] = [
    `${run}-numbers-paged`,
    `${run}-numbers-joined`,
  ];
  await journey(
    NUMBERS_NAME,
    async () => {
      const source = await numberSource(typedProject, prefix);
      const problems: string[] = [];
      // A failed check is kept and the journey goes on, so one red run names every defect the fix must remove.
      const step = async (
        label: string,
        body: () => unknown,
      ): Promise<void> => {
        try {
          await body();
        } catch (error) {
          problems.push(
            `${label}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
          );
        }
      };
      // A restored project holds every imported row unchanged, plus exactly one record and one event per derived floor.
      const settledOk = (dump: Dump): void => {
        same("derived floors", floorsOf(dump), SETTLED);
        for (const key of Object.keys(SETTLED))
          assert.equal(
            storedAt(dump, key)?.updatedBy.id,
            "cloud-restore",
            `${key} is written by the restore`,
          );
        same(
          "imported records",
          rowsIn(dump, "state_records").filter(
            (row) => !String(row.key).startsWith("allocation:"),
          ),
          source.tables.state_records,
        );
        const events = rowsIn(dump, "state_events");
        const imported = source.tables.state_events!.length;
        same(
          "imported events",
          events.slice(0, imported),
          source.tables.state_events,
        );
        same(
          "derived events",
          events
            .slice(imported)
            .map((row) => {
              const e = JSON.parse(String(row.body)) as {
                key: string;
                data: unknown;
                revision: number;
              };
              return [e.key, e.data, e.revision];
            })
            .sort(),
          // The Worker stores event data with sorted keys, so the expected object is built as { number, prefix }.
          Object.entries(SETTLED).map(([key, [p, n, r]]) => [
            key,
            { number: n, prefix: p },
            r,
          ]),
        );
        for (const table of [
          "state_leases",
          "state_requests",
          "domain_cloud_requests",
        ])
          same(table, rowsIn(dump, table), source.tables[table]);
      };

      // 1. A whole restore and a paged restore of the legacy source, each read back before any device exists.
      assert.equal(await initialized(typedProject), false);
      const restored = await adminCall(
        typedProject,
        "POST",
        "restore",
        JSON.stringify(source.doc),
      );
      ok(restored);
      await step(
        "whole restore derives every comment and link floor",
        async () => settledOk(await dumpOf(typedProject)),
      );
      const parts = cut(source.tables, 3);
      for (const [i, part] of parts.entries()) {
        ok(await sendPage(pagedTarget, part));
        assert.equal(await initialized(pagedTarget), i === parts.length - 1);
      }
      await step(
        "paged restore derives every comment and link floor",
        async () => settledOk(await dumpOf(pagedTarget)),
      );

      // 2. Devices after the restore. Two clients race; links all come from the one device that holds the lease of each issue it links.
      const a = await callerFor("numbers", false);
      const b: Caller = {
        ...a,
        device: await issue(typedProject, "typed-numbers-2", undefined, false),
      };
      const ids = [1, 2, 3].map((n) => `${prefix}-${n}`);
      const leases: number[] = [];
      for (const id of ids)
        leases.push(
          typedOk<Grant>(await typedCall(a, claimOf(`n-claim-${id}`, a, id)))
            .generation,
        );
      const g = (n: number): number => leases[n - 1]!;
      const before = await dumpOf(typedProject);

      // 3. Fresh adds, one at a time: each takes the number above everything ever accepted for its issue and kind.
      const key = (kind: string, issue: number, n: number): string =>
        `${kind}:work-${issue}:${n}`;
      const ordered: [Caller, Call, string][] = [
        [a, noteCall(a, "n-c1-11", ids[0]!), key("comment", 1, 11)],
        [a, linkCall(a, g(1), "n-l1-11", ids[0]!), key("link", 1, 11)],
        [a, noteCall(a, "n-c2-6", ids[1]!), key("comment", 2, 6)],
        [a, linkCall(a, g(2), "n-l2-4", ids[1]!), key("link", 2, 4)],
        [a, linkCall(a, g(3), "n-l3-4", ids[2]!), key("link", 3, 4)],
      ];
      const results = new Map<string, unknown>();
      const seen: string[] = [];
      for (const [who, call] of ordered) {
        const out = await landed(who, call);
        seen.push(out.got);
        results.set(call.requestId, out.result);
      }
      await step("fresh adds allocate above deleted and sparse history", () =>
        same(
          "keys",
          seen,
          ordered.map(([, , want]) => want),
        ),
      );

      // 4. Two clients race distinct adds of each kind: distinct, consecutive and above every earlier number.
      const raced = await Promise.all([
        landed(a, noteCall(a, "n-c1-12", ids[0]!)),
        landed(b, noteCall(b, "n-c1-13", ids[0]!)),
        landed(a, linkCall(a, g(1), "n-l1-12", ids[0]!)),
        landed(a, linkCall(a, g(1), "n-l1-13", ids[0]!)),
      ]);
      await step("concurrent adds get distinct consecutive suffixes", () =>
        same(
          "keys",
          [
            raced
              .slice(0, 2)
              .map((out) => out.got)
              .sort(),
            raced
              .slice(2)
              .map((out) => out.got)
              .sort(),
          ],
          [
            [key("comment", 1, 12), key("comment", 1, 13)],
            [key("link", 1, 12), key("link", 1, 13)],
          ],
        ),
      );

      // 5. Replays keep their answer, burn no number and write nothing. The link replay still holds its lease.
      const afterAdds = await dumpOf(typedProject);
      for (const [who, call] of [ordered[0]!, ordered[1]!])
        await step(`replay of ${call.requestId}`, async () => {
          same(
            "answer",
            (await landed(who, call)).result,
            results.get(call.requestId),
          );
        });
      await step("replays write nothing", async () =>
        same("dump", nameOf(await dumpOf(typedProject)), nameOf(afterAdds)),
      );

      // 6. Exact deltas: nine new records and receipts, five floors rewritten in place, two events per add, nothing else.
      const records = [
        ...ordered.map(([, , want]) => want),
        key("comment", 1, 12),
        key("comment", 1, 13),
        key("link", 1, 12),
        key("link", 1, 13),
      ];
      const floorKeys = [
        "comment:work-1:",
        "comment:work-1:",
        "comment:work-1:",
        "comment:work-2:",
        "link:work-1:",
        "link:work-1:",
        "link:work-1:",
        "link:work-2:",
        "link:work-3:",
      ].map((prefixed) => `allocation:${prefixed}`);
      const delta = changes(before, afterAdds);
      await step(
        "each add writes one record, one floor advance and one receipt",
        () => {
          same(
            "added",
            delta.added,
            [
              ...records.map((k) => `forge/work ${k}`),
              ...[
                ...ordered.map(([, c]) => c.requestId),
                "n-c1-12",
                "n-c1-13",
                "n-l1-12",
                "n-l1-13",
              ].map((id) => `forge/cloud request:${id}`),
            ].sort(),
          );
          same(
            "rewritten",
            delta.rewritten,
            [...new Set(floorKeys)].map((k) => `forge/work ${k}`).sort(),
          );
          same(
            "events",
            delta.workEvents,
            [...records, ...floorKeys].map((k) => `forge/work ${k}`).sort(),
          );
          assert.ok(
            delta.kept && delta.oldEvents,
            "an earlier row or event changed",
          );
          same("floors", floorsOf(afterAdds), AFTER_ADDS);
          same(
            "leases",
            rowsIn(afterAdds, "state_leases"),
            rowsIn(before, "state_leases"),
          );
        },
      );

      // 7. Full link records, and the read lists, in number order with the deleted numbers absent.
      await step(
        "link results are the stored records and the lists skip deleted numbers",
        async () => {
          for (const [, call, want] of ordered.filter(
            ([, c]) => c.op === "issue.link",
          )) {
            const stored = storedAt(afterAdds, want);
            same(call.requestId, results.get(call.requestId), stored);
            assert.equal(stored?.revision, 1, `${want} is at revision 1`);
          }
          const lists: [string, number, number[]][] = [
            ["issue.comments", 0, [1, 11, 12, 13]],
            ["issue.links", 0, [1, 11, 12, 13]],
            ["issue.comments", 1, [6]],
            ["issue.links", 1, [4]],
            ["issue.links", 2, [1, 3, 4]],
          ];
          for (const [op, n, want] of lists)
            same(
              `${op} ${ids[n]}`,
              suffixesOf(await typedRead(a, op, { id: ids[n]! })),
              want,
            );
        },
      );

      // 8. The holder lets go. A whole dump equals the pages of the same export; both restore into empty targets exactly,
      // floors included, with no replacement floor written.
      for (const id of ids)
        typedOk(
          await typedCall(a, {
            requestId: `n-release-${id}`,
            op: "issue.release",
            input: { id },
            context: asHolder(a, g(ids.indexOf(id) + 1)),
          }),
        );
      const whole = await dumpOf(typedProject);
      await step("the whole export equals its pages", async () =>
        same(
          "pages",
          nameOf(joined(await pagesOf(typedProject))),
          nameOf(whole),
        ),
      );
      const sent = await adminCall(
        second,
        "POST",
        "restore",
        JSON.stringify({ format: whole.format, tables: whole.tables }),
      );
      ok(sent);
      await step(
        "a second restore reads back every row and floor unchanged",
        async () => {
          same("whole", nameOf(await dumpOf(second)), nameOf(whole));
          same("floors", floorsOf(await dumpOf(second)), floorsOf(whole));
        },
      );
      for (const part of await pagesOf(typedProject)) {
        ok(await sendPage(joinedTarget, part));
      }
      await step(
        "a paged second restore reads back every row and floor unchanged",
        async () =>
          same("paged", nameOf(await dumpOf(joinedTarget)), nameOf(whole)),
      );
      writeFileSync(numbersState, JSON.stringify({ tables: whole.tables }));
      if (problems.length > 0)
        throw new Error(problems.join(" | ").slice(0, 3000));
    },
    240_000,
  );
}
if (phase === "numbers-restart") {
  // The second Worker, started on the same persistence, admits project *-b: the dump restored from *-a in the first run.
  const first = typedProject.replace(/b$/, "a");
  assert.notEqual(first, typedProject, "FORGE_CLOUD_PROJECT must end in b");
  const prefix = process.env.FORGE_CLOUD_ID_PREFIX ?? "ci";
  await journey(
    NUMBERS_RESTART_NAME,
    async () => {
      const saved = JSON.parse(readFileSync(numbersState, "utf8")) as {
        tables: Dump["tables"];
      };
      const kept = nameOf({
        format: "forge-cloud-dump/1",
        tables: saved.tables,
      });
      same("project a after the restart", nameOf(await dumpOf(first)), kept);
      same(
        "project b after the restart",
        nameOf(await dumpOf(typedProject)),
        kept,
      );
      same("settled floors", floorsOf(await dumpOf(typedProject)), AFTER_ADDS);
      const a = await callerFor("numbers-restart", false);
      const ids = [1, 2].map((n) => `${prefix}-${n}`);
      const leases: number[] = [];
      for (const id of ids)
        leases.push(
          typedOk<Grant>(await typedCall(a, claimOf(`r-claim-${id}`, a, id)))
            .generation,
        );
      const out = [
        await landed(a, noteCall(a, "r-c1", ids[0]!)),
        await landed(a, linkCall(a, leases[0]!, "r-l1", ids[0]!)),
        await landed(a, noteCall(a, "r-c2", ids[1]!)),
        await landed(a, linkCall(a, leases[1]!, "r-l2", ids[1]!)),
      ].map((one) => one.got);
      same("adds after the restart", out, [
        "comment:work-1:14",
        "link:work-1:14",
        "comment:work-2:7",
        "link:work-2:5",
      ]);
      same(
        "floors after the adds",
        floorsOf(await dumpOf(typedProject)),
        AFTER_RESTART,
      );
    },
    120_000,
  );
}

// The isolated budget runs (forge-1304) set their own DUMP_* limits from the workflow. budget-plan prints the page
// budget a run must be given, on a line of its own that starts with PLAN (the state owner logs other lines): the byte size of a page the oracle builds from accepted rows, never one the exporter cut.
if (phase === "budget-plan") {
  const oracle = await import("./budget.ts");
  const fixtures = await import("./max-source.ts");
  if (process.argv[3] === "exact") {
    const { tables } = await fixtures.tinySource("T");
    const size = oracle.utf8(oracle.finalPage(tables));
    assert.ok(
      size <= 4096 && Object.values(tables).flat().length > 0,
      `the exact fixture's final page is ${size} bytes`,
    );
    console.log(`PLAN ${size}`);
  } else {
    const { tables } = await fixtures.leaseSource(oracle.longSubject());
    console.log(
      `PLAN ${oracle.utf8(oracle.pageThrough(tables, oracle.leaseBoundary(tables)))}`,
    );
  }
}

if (phase === "budget") {
  // Small caps (131,072 stored bytes, 100 rows per table) and a page budget of exactly one tiny page.
  const budget = Number(process.env.BUDGET_PAGE_BYTES);
  const oracle = await import("./budget.ts");
  const { tinySource } = await import("./max-source.ts");
  const seed = async (name: string, doc: object): Promise<void> => {
    okValue(
      await adminCall(name, "POST", "restore", JSON.stringify(doc)),
      `${name} seed`,
    );
  };
  await journey(
    "budget exact: real final page restores at its inclusive limit",
    async () => {
      const fixture = await tinySource("T");
      assert.equal(
        oracle.utf8(oracle.finalPage(fixture.tables)),
        budget,
        "BUDGET_PAGE_BYTES is the size of the expected final page",
      );
      const [source, target] = [`${run}-exact-src`, `${run}-exact-dst`];
      await seed(source, fixture.doc);
      const trip = await roundTrip(source, target, "exact", budget);
      assert.equal(
        trip.bytes.length,
        1,
        `the export was cut into ${trip.bytes.length} pages, and the exact budget ${budget} holds one`,
      );
      assert.equal(
        trip.bytes[0],
        budget,
        `the real page is ${trip.bytes[0]} bytes, not the ${budget} byte budget`,
      );
      assert.deepEqual(trip.digests, oracle.digestOf(fixture.tables));
      showDigests("exact", trip.digests);
    },
  );
  await journey(
    "budget envelope: real continuation pages stay within their budget",
    async () => {
      // One more character in the title: the rows alone still fit the budget, but the page with its envelope does not.
      const fixture = await tinySource("TT");
      const empty = Object.fromEntries(
        Object.keys(fixture.tables).map((table) => [table, []]),
      );
      const shell = oracle.utf8(oracle.finalPage(empty));
      const bare = oracle.cutPages(fixture.tables, budget, oracle.utf8, false);
      const expected = oracle.cutPages(fixture.tables, budget);
      assert.equal(bare.length, 1, "the rows alone fit one page");
      assert.ok(
        oracle.utf8(bare[0]!) - shell <= budget &&
          oracle.utf8(bare[0]!) > budget,
        "the rows alone fit the budget but their page document does not",
      );
      assert.equal(expected.length, 2, "the last row moves to a second page");
      assert.equal(Object.values(expected[1]!.tables).flat().length, 1);
      const [source, target] = [`${run}-env-src`, `${run}-env-dst`];
      await seed(source, fixture.doc);
      const trip = await roundTrip(source, target, "envelope", budget);
      assert.deepEqual(
        trip.bytes,
        expected.map((page) => oracle.utf8(page)),
        "the real pages are not the expected pages",
      );
      assert.deepEqual(trip.digests, oracle.digestOf(fixture.tables));
      showDigests("envelope", trip.digests);
    },
  );
}

if (phase === "budget-cursor") {
  // The longest key state accepts (500 characters, here a lease subject) at a continuation boundary, followed through
  // the real encoded URL. Only a local workerd answers it: no hosted ingress limit is measured.
  const budget = Number(process.env.BUDGET_PAGE_BYTES);
  const oracle = await import("./budget.ts");
  const { leaseSource } = await import("./max-source.ts");
  await journey(
    "budget cursor: a long escaped key survives its real continuation URL",
    async () => {
      const subject = oracle.longSubject();
      assert.equal(subject.length, 500);
      const fixture = await leaseSource(subject);
      const first = oracle.pageThrough(
        fixture.tables,
        oracle.leaseBoundary(fixture.tables),
      );
      assert.equal(
        oracle.utf8(first),
        budget,
        "BUDGET_PAGE_BYTES is the size of the expected first page",
      );
      assert.equal(
        (JSON.parse(first.next!) as { k: string[] }).k[1],
        subject,
        "the first cursor names the long subject",
      );
      const expected = oracle.cutPages(fixture.tables, budget);
      assert.ok(expected.length >= 2 && expected[0]!.next === first.next);
      const [source, target] = [`${run}-cursor-src`, `${run}-cursor-dst`];
      okValue(
        await adminCall(source, "POST", "restore", JSON.stringify(fixture.doc)),
        "cursor seed",
      );
      const trip = await roundTrip(
        source,
        target,
        "cursor",
        budget,
        (page, text) =>
          assert.ok(
            text === JSON.stringify(expected[page.page]),
            `page ${page.page} is not the expected page`,
          ),
      );
      assert.equal(trip.bytes.length, expected.length);
      const url = Buffer.byteLength(
        `${base}/p/${source}/dump?cursor=${encodeURIComponent(first.next!)}`,
      );
      const bounds = oracle.cursorBounds(base);
      assert.equal(trip.urls[1], url, "the second request is the cursor URL");
      assert.ok(url <= bounds.state_leases!, "the URL is over its upper bound");
      assert.deepEqual(trip.digests, oracle.digestOf(fixture.tables));
      console.log(
        `INFO cursor: the continuation request URL is ${url} UTF-8 bytes for a ${subject.length} unit subject; upper bound per key shape: ${JSON.stringify(bounds)}; local workerd only`,
      );
      showDigests("cursor", trip.digests);
    },
  );
}

if (phase === "budget-body") {
  // One page near the 8 MiB restore body: page and stored caps of 8 MiB and 100 rows per table, set by the workflow.
  const limit = 8 * 1024 * 1024;
  const low = limit - 65_536;
  const oracle = await import("./budget.ts");
  const { nearSource } = await import("./max-source.ts");
  await journey(
    "budget body: real near-8-MiB page restores exactly",
    async () => {
      // The tail body is calculated from the independent page size: four rows carry it, a byte each, so one
      // estimate lands near the middle of the window, and at most two more builds correct it.
      const built: { tail: number; size: number }[] = [];
      const build = async (tail: number) => {
        const near = await nearSource(tail);
        const size = oracle.utf8(oracle.finalPage(near.tables));
        built.push({ tail, size });
        return { ...near, size };
      };
      let near = await build(1_000);
      for (let n = 0; n < 2 && (near.size < low || near.size > limit); n += 1) {
        const last = built.at(-1)!;
        const before = built.at(-2);
        const slope =
          before === undefined
            ? 4
            : (last.size - before.size) / (last.tail - before.tail);
        near = await build(
          Math.max(
            1,
            Math.round(last.tail + ((low + limit) / 2 - last.size) / slope),
          ),
        );
      }
      const rows = Object.fromEntries(
        Object.entries(near.tables).map(([table, list]) => [
          table,
          list.length,
        ]),
      );
      assert.ok(
        near.size >= low && near.size <= limit,
        `the expected page is ${near.size} bytes, outside ${low}..${limit} after ${built.length} builds`,
      );
      assert.ok(
        near.stored <= limit && Math.max(...Object.values(rows)) <= 100,
        `the fixture holds ${near.stored} stored bytes and ${JSON.stringify(rows)} rows`,
      );
      const text = JSON.stringify(oracle.finalPage(near.tables));
      assert.equal(Buffer.byteLength(text), near.size);
      const [source, target] = [`${run}-body-src`, `${run}-body-dst`];
      okValue(await adminCall(source, "POST", "restore", text), "body seed");
      const trip = await roundTrip(
        source,
        target,
        "body",
        limit,
        (_page, real) =>
          assert.ok(real === text, "the real page is not the expected page"),
      );
      assert.equal(trip.bytes.length, 1, "one real page holds the project");
      assert.ok(
        trip.bytes[0]! >= low,
        `the real page is ${trip.bytes[0]} bytes`,
      );
      assert.deepEqual(trip.digests, oracle.digestOf(near.tables));
      console.log(
        `INFO body: expected and real page ${near.size} bytes (${limit - near.size} under the restore body), ${near.stored} stored bytes, rows ${JSON.stringify(rows)}, builds ${JSON.stringify(built)}`,
      );
      showDigests("body", trip.digests);
    },
  );
}

if (failures.length > 0) {
  console.log(`${failures.length} failed: ${failures.join("; ")}`);
  process.exitCode = 1;
}
