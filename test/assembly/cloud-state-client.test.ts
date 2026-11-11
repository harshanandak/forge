import { expect, setDefaultTimeout, test } from "bun:test";
import type {
  CloudHttp,
  LeaseRefusalCode,
  LeaseResult,
  LeaseWriteBody,
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
type Run = (client: CloudLeaseClient) => Promise<unknown>;
const ops: [string, Run, unknown[]][] = [
  ["claim", (c) => c.claim(claim), [TOKEN, "claim", claim, undefined]],
  ["renew", (c) => c.renew(renew), [TOKEN, "renew", renew, undefined]],
  ["release", (c) => c.release(rel), [TOKEN, "release", rel, undefined]],
  ["holder", (c) => c.holder(SUBJECT), [TOKEN, SUBJECT, undefined]],
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
    answer?: LeaseResult | Error;
    signal?: AbortSignal;
  } = {},
) {
  const calls: unknown[][] = [];
  const answer: LeaseResult | Error = options.answer ?? {
    kind: "ok",
    lease: LEASE,
  };
  const reply = () =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  const record = (...args: unknown[]) => {
    calls.push(args);
    return reply();
  };
  const http: Pick<CloudHttp, "leaseWrite" | "leaseHolder"> = {
    leaseWrite: record,
    leaseHolder: record,
  };
  const credentials = credentialStore(
    filesWith(options.entries ?? [entry(NOW)], options.text),
  );
  const client = createCloudLeaseClient({
    key: options.key ?? KEY,
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
  const error = (code: string) =>
    new ForgeFailure({ code, message: "x", retry: "never" });
  const cases: [Error, string][] = [
    [error("UNAVAILABLE"), "UNAVAILABLE"],
    [error("INVOCATION_CANCELLED"), "INVOCATION_CANCELLED"],
    [new Error(`boom ${TOKEN}`), "UNAVAILABLE"],
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
