import { expect, setDefaultTimeout, test } from "bun:test";
import {
  createCloudHttp,
  type CloudFetch,
  type LeaseRefusalCode,
  type LeaseResult,
  type LeaseWriteBody,
} from "../../src/adapters/http/index.ts";
import {
  createCloudLeaseClient,
  type CloudLeaseClient,
} from "../../src/assembly/cloud-state-client.ts";
import { wireDeviceId } from "../../src/assembly/cloud-login.ts";
import {
  CREDENTIAL_FILE,
  credentialStore,
  type CredentialEntry,
  type CredentialKey,
} from "../../src/assembly/cloud-profile.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import type { LeaseRecord } from "../../src/generated/types.ts";
import type { DeviceFiles } from "../../src/ports/device-files.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  entry,
  ORIGIN,
  OTHER_ORIGIN,
  OTHER_PROJECT_ID,
  PROJECT,
  PROJECT_ID,
} from "./cloud-fixture.ts";

setDefaultTimeout(30_000);

const NOW = Date.UTC(2026, 10, 11);
const KEY: CredentialKey = {
  origin: ORIGIN,
  identity: PROJECT_ID,
  project: PROJECT,
};
const TOKEN = entry(NOW).token;
const SUBJECT = "issue:forge-1";
const holderOf = (session: string, device = "dev-1") => ({
  actor: { kind: "agent" as const, id: "a1" },
  session: { id: session, device, agent: "a1", harness: "claude" },
});
const LEASE: LeaseRecord = {
  subject: SUBJECT,
  holder: holderOf("s1"),
  generation: 3,
  expiresAt: "2026-11-11T12:00:00.000Z",
};
const base = { subject: SUBJECT, holder: holderOf("s1"), requestId: "req-1" };
const claim = { ...base, ttlMs: 60_000 };
const renew = { ...base, generation: 3, ttlMs: 60_000 };
const rel = { ...base, generation: 3 };
/** The adapter's success answer to any call: a lease for the lease routes, a result for a command. */
const OK = { kind: "ok" as const, lease: LEASE, result: LEASE };
const cmd = {
  requestId: "req-c",
  op: "issue.show",
  input: { id: "forge-1" },
  context: {
    actor: base.holder.actor,
    session: base.holder.session,
    project: { id: "ignored", root: "/home/u/repo" },
  },
};
const wireCmd = {
  ...cmd,
  context: { ...cmd.context, project: { id: PROJECT } },
};
type Run = (client: CloudLeaseClient) => Promise<unknown>;
const ops: [string, Run, unknown[]][] = [
  ["claim", (c) => c.claim(claim), [TOKEN, "claim", claim, undefined]],
  ["renew", (c) => c.renew(renew), [TOKEN, "renew", renew, undefined]],
  ["release", (c) => c.release(rel), [TOKEN, "release", rel, undefined]],
  ["holder", (c) => c.holder(SUBJECT), [TOKEN, SUBJECT, undefined]],
  ["command", (c) => c.command(cmd, () => true), [TOKEN, wireCmd, undefined]],
];

let touched = 0;
const never = (): never => {
  touched++;
  throw new Error("a local write was attempted");
};
/** The credential file in memory; every write, create and lock port fails if it is called. */
function filesWith(entries: CredentialEntry[], text?: string): DeviceFiles {
  const stored = Object.fromEntries(
    entries.map((e) => [`${e.origin}|${e.identity}|${e.project}`, e]),
  );
  const doc = text ?? JSON.stringify({ schema: 1, entries: stored });
  return {
    read: (name) => (name === CREDENTIAL_FILE ? doc : undefined),
    write: never,
    lock: never,
    pin: never,
    scratch: never,
  };
}
function rig(
  options: {
    entries?: CredentialEntry[];
    text?: string;
    key?: CredentialKey;
    bound?: Partial<CredentialKey>;
    answer?: LeaseResult | Error;
    signal?: AbortSignal;
  } = {},
) {
  const calls: unknown[][] = [];
  const answer: LeaseResult | Error = options.answer ?? OK;
  const reply = () =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  const record = (...args: unknown[]) => {
    calls.push(args);
    return reply() as Promise<never>;
  };
  const key = options.key ?? KEY;
  const http = {
    origin: options.bound?.origin ?? key.origin,
    project: options.bound?.project ?? key.project,
    leaseWrite: record,
    leaseHolder: record,
    command: record,
  };
  const credentials = credentialStore(
    filesWith(options.entries ?? [entry(NOW)], options.text),
  );
  const client = createCloudLeaseClient({
    key,
    credentials,
    now: () => NOW,
    http,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { client, calls };
}
async function failureOf(run: () => Promise<unknown>): Promise<ForgeFailure> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeFailure);
    expect(JSON.stringify(error)).not.toMatch(/boom|fct_/);
    return error as ForgeFailure;
  }
  throw new Error("expected a ForgeFailure");
}
/** The exit the existing mapper gives this failure as a FAIL envelope. */
const exit = (failed: ForgeFailure) =>
  exitCode({ ok: false, status: "FAIL", error: failed.error, warnings: [] });

for (const [name, run, sent] of ops)
  test(`${name} resolves to the adapter's result and sends the stored token and the caller's exact input`, async () => {
    const { client, calls } = rig();
    expect(await run(client)).toEqual(LEASE);
    expect(calls).toEqual([sent]);
  }, 10_000);

test("holder keeps a null, a released and a lapsed record exactly as the adapter gave them", async () => {
  const released = { ...LEASE, releasedAt: "2026-11-11T11:00:00.000Z" };
  const lapsed = { ...LEASE, expiresAt: "2020-01-01T00:00:00.000Z" };
  for (const lease of [null, released, lapsed]) {
    const { client } = rig({ answer: { kind: "ok", lease } });
    expect(await client.holder(SUBJECT)).toEqual(lease);
  }
}, 10_000);

const aged = entry(NOW, { expiresAt: new Date(NOW - 1).toISOString() });
const keyed = (more: Partial<CredentialKey>) => ({ key: { ...KEY, ...more } });
const unusable: [string, Parameters<typeof rig>[0], string][] = [
  ["no stored credential", { entries: [] }, "AUTH_REQUIRED"],
  ["a locally expired credential", { entries: [aged] }, "AUTH_REQUIRED"],
  ["another origin", keyed({ origin: OTHER_ORIGIN }), "AUTH_REQUIRED"],
  ["another identity", keyed({ identity: OTHER_PROJECT_ID }), "AUTH_REQUIRED"],
  ["another project name", keyed({ project: "other" }), "AUTH_REQUIRED"],
  ["an unreadable credential file", { text: "not json" }, "ACCOUNT_INTEGRITY"],
];
for (const [what, options, code] of unusable)
  test(`${what} is ${code} before any request, on every operation, and exits 1`, async () => {
    for (const [, run] of ops) {
      const { client, calls } = rig(options);
      const failed = await failureOf(() => run(client));
      expect(failed.error.code).toBe(code);
      expect(exit(failed)).toBe(1);
      expect(calls).toHaveLength(0);
    }
  }, 10_000);

test("a transport bound to another origin or project than the credential key is refused before any request", async () => {
  for (const bound of [{ origin: OTHER_ORIGIN }, { project: "other" }])
    for (const [, run] of ops) {
      const { client, calls } = rig({ bound });
      const failed = await failureOf(() => run(client));
      expect(failed.error.code).toBe("INPUT_INVALID");
      expect(exit(failed)).toBe(6);
      expect(calls).toHaveLength(0);
    }
}, 10_000);

test("a holder whose device is not the credential's device is refused before any request", async () => {
  const other = holderOf("s1", "other-device");
  const writes: Run[] = [
    (c) => c.claim({ ...claim, holder: other }),
    (c) => c.renew({ ...renew, holder: other }),
    (c) => c.release({ ...rel, holder: other }),
  ];
  for (const run of writes) {
    const { client, calls } = rig();
    const failed = await failureOf(() => run(client));
    expect(failed.error.code).toBe("AUTH_DEVICE_MISMATCH");
    expect(exit(failed)).toBe(1);
    expect(calls).toHaveLength(0);
  }
}, 10_000);

test("a local device id that is hashed on the wire is compared and sent in its wire form", async () => {
  const local = "me@host";
  const wire = wireDeviceId(local);
  expect(wire).not.toBe(local);
  const entries = [entry(NOW, { localDevice: local, device: wire })];
  const { client, calls } = rig({ entries });
  await client.claim({ ...claim, holder: holderOf("s1", local) });
  const sent = calls[0]?.[2] as LeaseWriteBody;
  expect(sent.holder).toEqual(holderOf("s1", wire));
  const bad = await failureOf(() =>
    client.claim({ ...claim, holder: holderOf("s1", "dev-1") }),
  );
  expect(bad.error.code).toBe("AUTH_DEVICE_MISMATCH");
  expect(calls).toHaveLength(1);
}, 10_000);

test("two sessions on one device each keep their own session in the holder", async () => {
  const { client, calls } = rig();
  await client.claim({ ...claim, holder: holderOf("s1") });
  await client.claim({ ...claim, holder: holderOf("s2"), requestId: "req-2" });
  const holders = calls.map((c) => (c[2] as LeaseWriteBody).holder);
  expect(holders).toEqual([holderOf("s1"), holderOf("s2")]);
}, 10_000);

const refusals = (
  "LEASE_HELD LEASE_STALE LEASE_NOT_HELD LEASE_EXPIRED INPUT_CONFLICT " +
  "INPUT_INVALID AUTH_REQUIRED AUTH_INVALID AUTH_REVOKED AUTH_EXPIRED AUTH_DEVICE_MISMATCH"
).split(" ") as LeaseRefusalCode[];
const details = { ...LEASE, holder: holderOf("s9", "dev-9"), generation: 4 };
for (const code of refusals)
  test(`${code} keeps its code, its details and its exit, and never the token`, async () => {
    const leased = code.startsWith("LEASE_");
    const answer: LeaseResult = {
      kind: "refused",
      code,
      ...(leased ? { lease: details } : {}),
    };
    const want =
      leased || code === "INPUT_CONFLICT"
        ? 4
        : code === "INPUT_INVALID"
          ? 6
          : 1;
    for (const [, run] of ops) {
      const { client, calls } = rig({ answer });
      const failed = await failureOf(() => run(client));
      expect(failed.error.code).toBe(code);
      expect(failed.error.lease).toEqual(leased ? details : undefined);
      expect(exit(failed)).toBe(want);
      expect(calls).toHaveLength(1);
    }
  }, 10_000);

test("an adapter UNAVAILABLE or cancellation passes through after one request, and an unexpected error becomes UNAVAILABLE without its text", async () => {
  const error = (code: string, message = "x", more = {}) =>
    new ForgeFailure({ code, message, retry: "never", ...more });
  const inDetails = {
    expected: TOKEN,
    lease: { subject: SUBJECT, holder: holderOf(TOKEN) },
  };
  const cases: [Error, string][] = [
    [error("UNAVAILABLE"), "UNAVAILABLE"],
    [error("INVOCATION_CANCELLED"), "INVOCATION_CANCELLED"],
    [new Error(`boom ${TOKEN}`), "UNAVAILABLE"],
    [error("UNAVAILABLE", TOKEN), "UNAVAILABLE"],
    [error("UNAVAILABLE", "x", inDetails), "UNAVAILABLE"],
    [error("WEIRD_CODE", TOKEN, inDetails), "UNAVAILABLE"],
    [error("INVOCATION_CANCELLED", TOKEN, inDetails), "INVOCATION_CANCELLED"],
  ];
  for (const [answer, code] of cases)
    for (const [, run] of ops) {
      const { client, calls } = rig({ answer });
      const failed = await failureOf(() => run(client));
      expect(failed.error.code).toBe(code);
      expect(exit(failed)).toBe(1);
      expect(calls).toHaveLength(1);
    }
}, 10_000);

test("the caller's signal reaches the adapter, and an abort is a cancellation, never a retry", async () => {
  const early = new AbortController();
  for (const [, run] of ops) {
    const { client, calls } = rig({ signal: early.signal });
    await run(client);
    expect(calls[0]?.at(-1)).toBe(early.signal);
  }
  early.abort();
  for (const [, run] of ops) {
    const { client, calls } = rig({
      signal: early.signal,
      answer: new Error("x"),
    });
    const failed = await failureOf(() => run(client));
    expect(failed.error.code).toBe("INVOCATION_CANCELLED");
    expect(calls).toHaveLength(1);
  }
}, 10_000);

test("a caller replay after an uncertain write reuses the same request id and body unchanged", async () => {
  const answer = new ForgeFailure({
    code: "UNAVAILABLE",
    message: "x",
    retry: "never",
  });
  const { client, calls } = rig({ answer });
  await failureOf(() => client.renew(renew));
  await failureOf(() => client.renew(renew));
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect((calls[1]?.[2] as LeaseWriteBody).requestId).toBe("req-1");
}, 10_000);

test("holder resolves while every local write, create and lock port fails if called", async () => {
  touched = 0;
  const { client } = rig();
  expect(await client.holder(SUBJECT)).toEqual(LEASE);
  expect(touched).toBe(0);
}, 10_000);

test("a command sends only requestId, op, input and the context, adds dryRun only when set, and never fills in the credential's device", async () => {
  const bare = {
    ...cmd,
    context: { actor: base.holder.actor, session: { id: "s1" } },
  };
  const withProject = {
    ...bare,
    context: { ...bare.context, project: { id: PROJECT } },
  };
  const cases = [
    [cmd, wireCmd],
    [
      { ...cmd, dryRun: true },
      { ...wireCmd, dryRun: true },
    ],
    [bare, withProject],
  ] as const;
  for (const [call, expected] of cases) {
    const { client, calls } = rig();
    await client.command(call, () => true);
    expect(calls).toEqual([[TOKEN, expected, undefined]]);
  }
  const { client, calls } = rig();
  await client.command(bare, () => true);
  expect(JSON.stringify(calls)).not.toContain("dev-1");
}, 10_000);

test("a command's named devices are sent in wire form, and a different device is refused before any request", async () => {
  const local = "me@host";
  const wire = wireDeviceId(local);
  const entries = [entry(NOW, { localDevice: local, device: wire })];
  const named = {
    ...cmd.context,
    device: { id: local },
    session: { id: "s1", device: local },
  };
  const good = rig({ entries });
  await good.client.command({ ...cmd, context: named }, () => true);
  const sent = (good.calls[0]?.[1] as { context: typeof named }).context;
  expect([sent.device.id, sent.session.device]).toEqual([wire, wire]);
  for (const context of [
    { ...cmd.context, session: { id: "s1", device: "other-device" } },
    { ...cmd.context, device: { id: "other-device" } },
  ]) {
    const { client, calls } = rig();
    const failed = await failureOf(() =>
      client.command({ ...cmd, context }, () => true),
    );
    expect(failed.error.code).toBe("AUTH_DEVICE_MISMATCH");
    expect(exit(failed)).toBe(1);
    expect(calls).toHaveLength(0);
  }
}, 10_000);

test("a result that fails the output schema, or a validator that throws, is UNAVAILABLE with the fixed message after one request", async () => {
  const seen: unknown[] = [];
  const bad = [
    (result: unknown) => {
      seen.push(result);
      return false;
    },
    (result: unknown) => {
      seen.push(result);
      throw new Error(`validator saw ${TOKEN}`);
    },
  ];
  for (const validate of bad) {
    const { client, calls } = rig();
    const failed = await failureOf(() => client.command(cmd, validate));
    expect(failed.error.code).toBe("UNAVAILABLE");
    expect(failed.error.message).toBe("The Forge cloud gave no usable answer.");
    expect(JSON.stringify(failed.error)).not.toContain("saw");
    expect(exit(failed)).toBe(1);
    expect(calls).toHaveLength(1);
  }
  expect(seen).toEqual([LEASE, LEASE]);
}, 10_000);

// A refused command carries the checked lease, blocker and repair details into the failure, as the local engine would.
const OWNED: LeaseRecord = {
  subject: SUBJECT,
  holder: holderOf("s9", "dev-9"),
  generation: 4,
  expiresAt: "2026-11-11T12:00:00.000Z",
};
const conflictOf = (lease: LeaseRecord) => ({
  subject: lease.subject,
  holder: lease.holder,
  generation: lease.generation,
  expiresAt: lease.expiresAt,
});
function localError(
  current: LeaseRecord | undefined,
  mode: "acquire" | "held",
  generation = 3,
) {
  const decision = decideLease(current, {
    mode,
    subject: SUBJECT,
    holder: holderOf("s1"),
    nowMs: NOW,
    generation,
  });
  if (decision.ok) throw new Error("the local engine granted the lease");
  return decision.error;
}
const refusedWith = (code: string, more: object) =>
  ({ kind: "refused", code, ...more }) as never;
const commandFailure = (answer: LeaseResult) =>
  failureOf(() => rig({ answer }).client.command(cmd, () => true));

test("a refused command's LEASE_HELD is the complete local error, with the holder, generation and expiry", async () => {
  const answer = refusedWith("LEASE_HELD", { lease: conflictOf(OWNED) });
  const { client, calls } = rig({ answer });
  const failed = await failureOf(() => client.command(cmd, () => true));
  expect(failed.error).toEqual(localError(OWNED, "acquire"));
  expect(exit(failed)).toBe(4);
  expect(calls).toHaveLength(1);
}, 10_000);

const lapsed = { ...OWNED, expiresAt: "2026-11-10T00:00:00.000Z" };
const others: [string, LeaseRecord | undefined, "held", number][] = [
  ["LEASE_STALE", OWNED, "held", 3],
  ["LEASE_NOT_HELD", undefined, "held", 3],
  ["LEASE_NOT_HELD", OWNED, "held", 4],
  ["LEASE_EXPIRED", { ...lapsed, holder: holderOf("s1") }, "held", 4],
];
for (const [code, current, mode, generation] of others)
  test(`a refused command's ${code} keeps the local lease fields and retry posture${current === undefined ? " with only the subject" : ""}`, async () => {
    const want = localError(current, mode, generation);
    expect(want.code).toBe(code as never);
    const lease = want.lease;
    const failed = await commandFailure(refusedWith(code, { lease }));
    expect([failed.error.code, failed.error.retry, failed.error.lease]).toEqual(
      [want.code, want.retry, want.lease],
    );
    expect(exit(failed)).toBe(4);
    expect(failed.error.message).not.toContain(TOKEN);
  }, 10_000);

test("a refused command's CLAIM_BLOCKED keeps exactly the blocker edges, retry never, and no repair", async () => {
  const blockers = [
    { id: "forge-8" },
    { id: "forge-9", holder: holderOf("s9"), holderUnverified: true },
  ];
  const failed = await commandFailure(
    refusedWith("CLAIM_BLOCKED", { observed: { blockers } }),
  );
  expect(failed.error.observed).toEqual({ blockers });
  expect([failed.error.retry, failed.error.repair]).toEqual([
    "never",
    undefined,
  ]);
  expect(Object.keys(failed.error).sort()).toEqual([
    "code",
    "message",
    "observed",
    "retry",
  ]);
  expect(exit(failed)).toBe(1);
}, 10_000);

test("a refused command's INPUT_CONFLICT keeps a checked repair, and has none when the adapter gave none", async () => {
  const repair = `forge attempt select forge-1 --attempt <attempt-id> --reason "<why>"; or forge attempt select forge-1 --none --reason "<why>"`;
  const kept = await commandFailure(refusedWith("INPUT_CONFLICT", { repair }));
  expect([kept.error.repair, kept.error.retry, exit(kept)]).toEqual([
    repair,
    "never",
    4,
  ]);
  const bare = await commandFailure(refusedWith("INPUT_CONFLICT", {}));
  expect(Object.keys(bare.error).sort()).toEqual(["code", "message", "retry"]);
}, 10_000);

// A success answer that carries the presented token is refused wherever the string sits. Only that token
// counts: a different device-token-shaped value is ordinary text.
const NOT_USABLE = "The Forge cloud gave no usable answer.";
const ECHO = `before-${TOKEN}-after`;
const FOREIGN = `fct_bbbbbbbbbbbbbbbb.${"P".repeat(43)}`;
const withHolder = (session: string): LeaseRecord => ({
  ...LEASE,
  holder: holderOf(session),
});

for (const [name, run] of ops)
  test(`${name} refuses a success answer that carries the presented token as the fixed UNAVAILABLE after one request`, async () => {
    const echoed = withHolder(ECHO);
    const answer = { kind: "ok" as const, lease: echoed, result: echoed };
    const { client, calls } = rig({ answer });
    const failed = await failureOf(() => run(client));
    expect(failed.error).toMatchObject({
      code: "UNAVAILABLE",
      message: NOT_USABLE,
    });
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    expect(exit(failed)).toBe(1);
    expect(calls).toHaveLength(1);
  }, 10_000);

for (const [where, result] of [
  ["a top-level string", { title: ECHO }],
  ["a string in a list", { id: "forge-1", labels: ["a", ECHO] }],
  ["a string deep in objects and lists", { items: [{ notes: [{ b: ECHO }] }] }],
] as const)
  test(`a command result with the token in ${where} is refused as the fixed UNAVAILABLE`, async () => {
    const { client, calls } = rig({
      answer: { kind: "ok", lease: LEASE, result } as never,
    });
    const failed = await failureOf(() => client.command(cmd, () => true));
    expect(failed.error).toMatchObject({
      code: "UNAVAILABLE",
      message: NOT_USABLE,
    });
    expect(JSON.stringify(failed)).not.toContain("before-");
    expect(exit(failed)).toBe(1);
    expect(calls).toHaveLength(1);
  }, 10_000);

for (const [name, run] of ops)
  test(`${name} returns a success answer that holds only a different device token unchanged`, async () => {
    const other = withHolder(FOREIGN);
    const answer = { kind: "ok" as const, lease: other, result: other };
    const { client } = rig({ answer });
    expect(await run(client)).toEqual(other);
  }, 10_000);

/** The real adapter over a scripted body, so the wire text is decoded the way a response is. */
function wired(text: string) {
  const bodies: string[] = [];
  const fetch: CloudFetch = () => {
    bodies.push(text);
    return Promise.resolve(
      new Response(text, { headers: { "content-type": "application/json" } }),
    );
  };
  const http = createCloudHttp({ origin: ORIGIN, project: PROJECT, fetch });
  const client = createCloudLeaseClient({
    key: KEY,
    credentials: credentialStore(filesWith([entry(NOW)])),
    now: () => NOW,
    http,
  });
  return { client, bodies };
}
const escaped = (value: unknown) =>
  JSON.stringify(value).replace(TOKEN, `\u0066${TOKEN.slice(1)}`);
const ESCAPED_ROWS: [string, string, Run][] = [
  [
    "a command result",
    escaped({
      ok: true,
      op: "issue.show",
      status: "OK",
      result: { id: "forge-1", title: ECHO },
      warnings: [],
    }),
    (c) => c.command(cmd, () => true),
  ],
  [
    "a holder lease",
    escaped({ ok: true, value: withHolder(ECHO) }),
    (c) => c.holder(SUBJECT),
  ],
  [
    "a claimed lease",
    escaped({ ok: true, value: withHolder(ECHO) }),
    (c) => c.claim(claim),
  ],
];
for (const [what, text, run] of ESCAPED_ROWS)
  test(`${what} that spells the token with a JSON escape on the wire is refused as the fixed UNAVAILABLE`, async () => {
    expect(text).toContain("\u0066ct_");
    expect(text).not.toContain(TOKEN);
    const { client, bodies } = wired(text);
    const failed = await failureOf(() => run(client));
    expect(failed.error).toMatchObject({
      code: "UNAVAILABLE",
      message: NOT_USABLE,
    });
    expect(exit(failed)).toBe(1);
    expect(bodies).toHaveLength(1);
  }, 10_000);
