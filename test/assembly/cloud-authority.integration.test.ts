import {
  afterAll,
  beforeAll,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockCapture } from "../../src/assembly/capture.ts";
import { cloudRoute, selectCloud } from "../../src/assembly/cloud-authority.ts";
import { wireDeviceId } from "../../src/assembly/cloud-login.ts";
import {
  CREDENTIAL_FILE,
  credentialStore,
  openCloudFiles,
  type CloudBinding,
  type CredentialEntry,
} from "../../src/assembly/cloud-profile.ts";
import { firstPartyBlocks } from "../../src/assembly/first-party.ts";
import { localIdentityResolver } from "../../src/assembly/identity.ts";
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import { LocalState } from "../../src/assembly/state.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { mcpToolName } from "../../src/contract/naming.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { discoveryOperations } from "../../src/generated/core-discovery.ts";
import type {
  FailureEnvelope,
  InvocationRequest,
  LeaseRecord,
  ResultEnvelope,
} from "../../src/generated/types.ts";
import { runCli } from "../../src/surface/cli.ts";
import { dispatch } from "../../src/surface/dispatch.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { exitCode, respond } from "../../src/surface/result.ts";
import { stageBlock } from "../blocks/memory/lib.ts";
import * as fx from "./cloud-fixture.ts";

setDefaultTimeout(30_000);
const NOW = Date.UTC(2026, 10, 11);
const iso = (ms: number) => new Date(ms).toISOString();
const TOKEN = fx.entry(NOW).token;
const LEASE = {
  subject: "issue:forge-1",
  holder: {
    actor: { kind: "agent", id: "a1" },
    session: { id: "s1", device: "dev-1" },
  },
  generation: 2,
  expiresAt: iso(NOW + 60_000),
};
const ISSUE = {
  id: "forge-1",
  title: "Issue 1",
  status: "open",
  labels: ["a"],
  dependsOn: [],
  createdAt: iso(NOW - 1000),
  updatedAt: iso(NOW),
  revision: 3,
};
const PAGE = { items: [ISSUE], truncated: false };
const answer = (result: object = ISSUE, op = "issue.show") =>
  fx.json({ ok: true, op, status: "OK", result, warnings: [] });
const COMMENTED = { id: "forge-1", commentId: "c-1" };
const RECORD = {
  namespace: "forge/work",
  key: "comment:work-1:1",
  revision: 1,
  value: { id: "work-1", body: "hi" },
  updatedAt: iso(NOW),
  updatedBy: { kind: "agent", id: "a1" },
};
const RECORDS = { records: [RECORD] };
const NOTES = { id: "forge-1" };
/** The status the cloud's command route gives each refusal (cloud/src/project.ts STATUS). */
const HTTP: Record<string, number> = {
  NOT_FOUND: 404,
  INPUT_CONFLICT: 409,
  INPUT_INVALID: 400,
  CONTEXT_MISSING: 400,
  UNKNOWN_COMMAND: 404,
  RECEIPT_REQUIRED: 400,
  INTERNAL: 500,
  REVISION_CONFLICT: 409,
  LEASE_HELD: 409,
  CLAIM_BLOCKED: 409,
  LEASE_NOT_HELD: 409,
  LEASE_STALE: 409,
  LEASE_EXPIRED: 409,
  AUTH_DEVICE_MISMATCH: 403,
};
const CLOUD_HOLDER = {
  actor: { kind: "agent", id: "a2" },
  session: { id: "s9", device: "dev-9", agent: "a2", harness: "claude" },
} as const;
/** The lease a losing claim names: the canonical subject, never the shown prefix. */
const heldBy = (digits = "1"): LeaseRecord => ({
  subject: `issue:work-${digits}`,
  holder: CLOUD_HOLDER,
  generation: 4,
  expiresAt: iso(NOW + 60_000),
});
const BLOCKERS = [
  { id: "forge-2" },
  { id: "forge-3", holder: CLOUD_HOLDER, holderUnverified: true },
];
/** The cloud's refusal as the Worker sends it: the lease and blocker details its codes carry. */
const refusing = (
  code: string,
  extra: object = code.startsWith("LEASE_")
    ? { lease: heldBy() }
    : code === "CLAIM_BLOCKED"
      ? { observed: { blockers: BLOCKERS } }
      : {},
) =>
  fx.json(
    {
      ok: false,
      status: "FAIL",
      error: { code, message: TOKEN, ...extra },
      warnings: [],
    },
    HTTP[code] ?? 401,
  );
const MANIFEST = resolve(
  import.meta.dirname,
  "../../src/blocks/work/forge.block.json",
);
const READS = ["issue.show", "issue.list", "issue.ready", "issue.comments"];
const WRITES = [
  "issue.create",
  "issue.comment",
  "issue.update",
  "issue.dep",
  "issue.link",
  "issue.close",
  "issue.claim",
  "issue.renew",
  "issue.release",
];
const SERVED = [...READS, ...WRITES];
/** Every operation the work block declares, read from its manifest. */
const MANIFEST_OPS = Object.keys(
  (JSON.parse(readFileSync(MANIFEST, "utf8")) as { operations: object })
    .operations,
);
const DECLARED = MANIFEST_OPS.filter((op) => !SERVED.includes(op));
const notServed = (op: string) =>
  `${op} is not served by the cloud authority of a cloud-bound project yet.`;
const yaml = (extra: object = {}) =>
  JSON.stringify({
    schemaVersion: "forge.config/1",
    blocks: { work: { source: { builtin: "forge/work" }, ...extra } },
  });
const WORK = yaml();

/** The shipped blocks are staged as the installed package carries them: compiled entries. */
let staging: string;
let capture: ReturnType<typeof spyOn<typeof blockCapture, "open">>;
beforeAll(() => {
  staging = mkdtempSync(join(tmpdir(), "forge-authority-blocks-"));
  const [memory, work] = ["forge/memory", "forge/work"].map((id) =>
    fileURLToPath(firstPartyBlocks[id]!),
  );
  const target = join(staging, "work");
  cpSync(work!, target, {
    recursive: true,
    filter: (path) => !path.endsWith(".cts"),
  });
  const source = readFileSync(join(work!, "entry.cts"), "utf8");
  const entry = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  writeFileSync(join(target, "entry.cjs"), entry);
  const stages = new Map([
    [memory!, stageBlock("memory", staging)],
    [work!, target],
  ]);
  const open = blockCapture.open.bind(blockCapture);
  capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    open(stages.get(path) ?? path),
  );
});
afterAll(() => {
  capture.mockRestore();
  rmSync(staging, { recursive: true, force: true });
});

interface Setup {
  bind?: Partial<CloudBinding> | string | false;
  creds?: Partial<CredentialEntry> | false;
  device?: string | false;
  steps?: fx.Step[];
  config?: string;
  prepare?: (s: fx.Sandbox) => void | Promise<void>;
  /** False runs the real local store, for the unbound project. */
  sentinel?: boolean;
}
/** A bound project under a throwing sentinel on the real project-state acquisition. */
async function using(
  o: Setup,
  run: (r: Awaited<ReturnType<typeof rig>>) => Promise<void>,
) {
  const r = await rig(o);
  try {
    await run(r);
    expect(r.sentinel?.mock.calls.length ?? 0).toBe(0);
  } finally {
    await r.assembly.close();
    r.sentinel?.mockRestore();
    r.s.close();
  }
}
async function rig(o: Setup) {
  const s = fx.sandbox();
  writeFileSync(join(s.root, ".forge", "config.yaml"), o.config ?? WORK);
  if (o.bind !== false)
    writeFileSync(
      s.binding,
      typeof o.bind === "string"
        ? o.bind
        : `${JSON.stringify(fx.bindingFor(o.bind))}\n`,
    );
  if (o.creds !== false)
    await credentialStore(openCloudFiles(s.home)).save(fx.entry(NOW, o.creds));
  await o.prepare?.(s);
  const net = fx.network(...(o.steps ?? [() => answer()]));
  const sentinel =
    o.sentinel === false
      ? undefined
      : spyOn(LocalState.prototype, "acquire").mockImplementation(() => {
          throw new Error("local state acquired");
        });
  const env = {
    HOME: s.home,
    ...(o.device === false ? {} : { FORGE_DEVICE_ID: o.device ?? "dev-1" }),
  };
  /** A person at a terminal who is asked and declines, so an approval request is counted and nothing is approved. */
  const confirm = mock(() => Promise.resolve(false));
  const terminal = { tty: () => ({ stdin: true, stderr: true }), confirm };
  const open = (root = s.root) =>
    createAssembly({
      root,
      deviceRoot: s.deviceRoot,
      providers: { env, cloudLogin: { fetch: net.fetch, now: () => NOW } },
      terminal,
    });
  const assembly = await open(); // requests carry the context a real CLI or MCP call builds
  const request = (
    op: string,
    input: object,
    change: Partial<InvocationRequest> = {},
  ): InvocationRequest => ({
    schemaVersion: "forge.invocation/1",
    requestId: "r-1",
    op,
    input,
    caller: "agent",
    context: localContext(assembly, { kind: "agent", id: "a1" }),
    ...change,
  });
  return { s, net, sentinel, open, request, assembly, confirm };
}
const show = (r: Awaited<ReturnType<typeof rig>>) =>
  r.assembly.catalog.invoke(r.request("issue.show", { id: "forge-1" }));
const failed = (result: Awaited<ReturnType<typeof show>>, code: string) => {
  expect(result).toMatchObject({ ok: false, error: { code } });
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  return exitCode(result);
};

test("a bound project's issue show is answered by the cloud with the stored token, and no local state opens", () =>
  using({}, async (r) => {
    expect(await show(r)).toMatchObject({ ok: true, result: ISSUE });
    expect(r.net.calls).toHaveLength(1);
    const call = r.net.calls[0]!;
    const body = call.body as { context: { project: unknown } };
    expect(call.url).toBe(`${fx.ORIGIN}/p/${fx.PROJECT}/command`);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(body).sort()).toEqual([
      "context",
      "input",
      "op",
      "requestId",
    ]);
    expect(body.context.project).toEqual({ id: fx.PROJECT });
    expect(body).toMatchObject({ context: { device: { id: "dev-1" } } });
  }));

test("the routing decision serves show, list, ready, comments, create, comment, update, dep, link, close, claim, renew and release, refuses every other operation of the work block by name, and leaves other blocks local", () => {
  // The refused set is exactly the manifest minus the served list: a served name the manifest does not declare would hide here.
  for (const op of SERVED) expect(MANIFEST_OPS).toContain(op);
  expect(DECLARED).toHaveLength(MANIFEST_OPS.length - SERVED.length);
  expect(DECLARED).toContain("issue.board");
  expect(DECLARED).not.toContain("issue.link");
  for (const op of SERVED) expect(cloudRoute("forge/work", op)).toBe("cloud");
  expect(cloudRoute("forge/work", "issue.link")).toBe("cloud");
  expect(cloudRoute("forge/memory", "memory.list")).toBe("local");
  for (const op of DECLARED) {
    const route = cloudRoute("forge/work", op);
    expect(route).toBeInstanceOf(ForgeFailure);
    expect(route).toMatchObject({
      error: { code: "INPUT_INVALID", message: notServed(op) },
    });
  }
});

const RENAMED = yaml({ rename: { issue: "ticket" } });
const CREATE = { title: "x", kind: "task" };
const COMMENT = { id: "forge-1", body: "hi" };
const UPDATE = { id: "forge-1", expectRevision: 3, title: "Renamed" };
const UPDATED = { ...ISSUE, title: "Renamed", revision: 4 };
const DEP = {
  id: "forge-1",
  target: "forge-2",
  action: "add",
  expectRevision: 3,
};
const CLOSE = { id: "forge-1", reason: "done", withoutReceipt: "guard" };
const LINK = {
  id: "forge-1",
  relation: "pr",
  url: "https://example.com/pull/1",
};
/** The whole record the cloud stores for a link: its own id and key, never the shown prefix. */
const LINKED = {
  ...RECORD,
  key: "link:work-1:1",
  value: { id: "work-1", relation: LINK.relation, url: LINK.url },
};
const HELD = { ...LEASE, generation: 3 };
const INPUTS: Record<string, object> = {
  "issue.create": CREATE,
  "issue.comment": COMMENT,
  "issue.update": UPDATE,
  "issue.dep": DEP,
  "issue.link": LINK,
  "issue.close": CLOSE,
  "issue.claim": { id: "forge-1" },
  "issue.renew": { id: "forge-1" },
  "issue.release": { id: "forge-1" },
};
for (const [source, op, input, declared, result] of [
  [WORK, "issue.create", CREATE, "issue.create", ISSUE],
  [RENAMED, "ticket.create", CREATE, "issue.create", ISSUE],
  [WORK, "issue.comment", COMMENT, "issue.comment", COMMENTED],
  [RENAMED, "ticket.comment", COMMENT, "issue.comment", COMMENTED],
  [RENAMED, "ticket.show", { id: "forge-1" }, "issue.show", ISSUE],
  [WORK, "issue.comments", NOTES, "issue.comments", RECORDS],
  [RENAMED, "ticket.comments", NOTES, "issue.comments", RECORDS],
] as const)
  test(`through the assembled catalog, ${op} on a bound project is answered by the cloud as ${declared}`, () =>
    using(
      { config: source, steps: [() => answer(result, declared)] },
      async (r) => {
        const done = await r.assembly.catalog.invoke(r.request(op, input));
        expect(done).toMatchObject({ ok: true, op, result });
        expect(exitCode(done)).toBe(0);
        expect(JSON.stringify(done)).not.toContain(TOKEN);
        expect(r.net.calls).toHaveLength(1);
        expect(r.net.calls[0]!.body).toMatchObject({
          requestId: "r-1",
          op: declared,
          input,
        });
      },
    ));

test("every other work operation is refused by name on a bound project, with no request", () =>
  using({}, async (r) => {
    const own = r.request("x", {}).context;
    const context = { ...own, session: { id: "s1" }, leaseGeneration: 3 };
    const result = await r.assembly.catalog.invoke(
      r.request("issue.board", {}, { context }),
    );
    expect(failed(result, "INPUT_INVALID")).toBe(6);
    expect(result).toMatchObject({
      error: { message: notServed("issue.board") },
    });
    expect(r.net.calls).toHaveLength(0);
  }));

for (const [name, op, input, bad] of [
  [
    "a token in the revision",
    "issue.create",
    CREATE,
    { ...ISSUE, revision: TOKEN },
  ],
  ["an extra key", "issue.comment", COMMENT, { ...COMMENTED, extra: TOKEN }],
  ["no commentId", "issue.comment", COMMENT, { id: "forge-1" }],
  ["no records", "issue.comments", NOTES, {}],
  ["records that is not a list", "issue.comments", NOTES, { records: "x" }],
  [
    "an extra top-level key",
    "issue.comments",
    NOTES,
    { records: [], truncated: false },
  ],
  [
    "an invalid record carrying the token",
    "issue.comments",
    NOTES,
    { records: [{ ...RECORD, revision: TOKEN }] },
  ],
] as const)
  test(`a cloud ${op} result with ${name} fails its declared output and is refused as UNAVAILABLE`, () =>
    using({ steps: [() => answer(bad, op)] }, async (r) => {
      const result = await r.assembly.catalog.invoke(r.request(op, input));
      expect(failed(result, "UNAVAILABLE")).toBe(1);
      expect(r.net.calls).toHaveLength(1);
    }));

for (const [code, exit] of [
  ["NOT_FOUND", 3],
  ["INPUT_CONFLICT", 4],
  ["INPUT_INVALID", 6],
  ["INTERNAL", 1],
] as const)
  for (const [op, input] of [
    ["issue.create", CREATE],
    ["issue.comment", COMMENT],
    ["issue.comments", NOTES],
  ] as const)
    test(`a cloud ${code} on ${op} keeps its code and exit ${exit}, without the token`, () =>
      using({ steps: [() => refusing(code)] }, async (r) => {
        const result = await r.assembly.catalog.invoke(r.request(op, input));
        expect(failed(result, code)).toBe(exit);
        expect(r.net.calls).toHaveLength(1);
      }));

for (const [op, input] of [
  ["issue.create", CREATE],
  ["issue.comment", COMMENT],
  ["issue.comments", NOTES],
  ["issue.update", UPDATE],
  ["issue.dep", DEP],
  ["issue.link", LINK],
  ["issue.close", CLOSE],
  ["issue.claim", INPUTS["issue.claim"]!],
  ["issue.renew", INPUTS["issue.renew"]!],
  ["issue.release", INPUTS["issue.release"]!],
] as const)
  test(`${op} as a dry run on a bound project is UNAVAILABLE and creates nothing`, () =>
    using({}, async (r) => {
      const dry = r.request(op, input, { dryRun: true });
      expect(failed(await r.assembly.catalog.invoke(dry), "UNAVAILABLE")).toBe(
        1,
      );
      expect(r.net.calls).toHaveLength(0);
    }));

test("a routed write that reaches the selector as a dry run is refused before any request, whatever the runtime's own checks did", () =>
  using({}, async (r) => {
    for (const op of WRITES) {
      const request = r.request(op, INPUTS[op]!, { dryRun: true });
      const flight = {
        request,
        block: { manifest: { id: "forge/work" }, validate: () => true },
        operation: { declaredOp: op, declaration: { output: {} } },
        context: {},
      };
      await expect(
        selectCloud(
          {
            root: r.s.root,
            deviceRoot: r.s.deviceRoot,
            scope: () => {},
            env: { HOME: r.s.home, FORGE_DEVICE_ID: "dev-1" },
            cloud: { fetch: r.net.fetch, now: () => NOW },
          },
          { preflight: () => flight } as never,
          request,
        ),
      ).rejects.toMatchObject({ error: { code: "UNAVAILABLE" } });
    }
    expect(r.net.calls).toHaveLength(0);
  }));

const FILTERS = { status: "open", labels: ["a"], limit: 5 };
for (const [source, op, input, declared] of [
  [WORK, "issue.list", {}, "issue.list"],
  [WORK, "issue.list", FILTERS, "issue.list"],
  [WORK, "issue.ready", {}, "issue.ready"],
  [RENAMED, "ticket.list", FILTERS, "issue.list"],
  [RENAMED, "ticket.ready", {}, "issue.ready"],
] as const)
  test(`through the assembled catalog, ${op} ${JSON.stringify(input)} on a bound project is answered by the cloud as ${declared}`, () =>
    using(
      { config: source, steps: [() => answer(PAGE, declared)] },
      async (r) => {
        const result = await r.assembly.catalog.invoke(r.request(op, input));
        expect(result).toMatchObject({ ok: true, result: PAGE });
        expect(exitCode(result)).toBe(0);
        expect(JSON.stringify(result)).not.toContain(TOKEN);
        expect(r.net.calls).toHaveLength(1);
        expect(r.net.calls[0]!.body).toMatchObject({ op: declared, input });
      },
    ));

for (const op of ["issue.list", "issue.ready"])
  for (const [name, bad] of [
    ["a missing truncated", { items: [] }],
    ["an extra key", { items: [], truncated: false, extra: 1 }],
    [
      "an invalid item carrying the token",
      { items: [{ ...ISSUE, revision: TOKEN }], truncated: false },
    ],
  ] as const)
    test(`a cloud ${op} result with ${name} is refused as UNAVAILABLE, never passed through`, () =>
      using({ steps: [() => answer(bad, op)] }, async (r) => {
        expect(
          failed(
            await r.assembly.catalog.invoke(r.request(op, {})),
            "UNAVAILABLE",
          ),
        ).toBe(1);
        expect(r.net.calls).toHaveLength(1);
      }));

for (const op of ["issue.list", "issue.ready"])
  test(`${op} on a bound project is UNAVAILABLE with no request as a dry run, and a server refusal keeps its code without the token`, () =>
    using({ steps: [() => refusing("AUTH_REVOKED")] }, async (r) => {
      const dry = r.request(op, {}, { dryRun: true });
      expect(failed(await r.assembly.catalog.invoke(dry), "UNAVAILABLE")).toBe(
        1,
      );
      expect(r.net.calls).toHaveLength(0);
      const live = await r.assembly.catalog.invoke(r.request(op, {}));
      expect(failed(live, "AUTH_REVOKED")).toBe(1);
      expect(r.net.calls).toHaveLength(1);
    }));

for (const [source, noun] of [
  [WORK, "issue"],
  [RENAMED, "ticket"],
] as const)
  test(`through the CLI wrapper, ${noun} comments reads the cloud with one request, and --dry-run is UNAVAILABLE with none`, () =>
    using(
      { config: source, steps: [() => answer(RECORDS, "issue.comments")] },
      async (r) => {
        const own = { caller: "agent", context: holding(r) } as const;
        const dry = await runCli(
          r.assembly.catalog,
          [noun, "comments", "forge-1", "--dry-run"],
          own,
        );
        dryRefused(r, dry.envelope);
        expect(dry.exitCode).toBe(1);
        const done = await runCli(
          r.assembly.catalog,
          [noun, "comments", "forge-1"],
          own,
        );
        expect(done.envelope).toMatchObject({
          ok: true,
          op: `${noun}.comments`,
          result: RECORDS,
        });
        expect(done.exitCode).toBe(0);
        expect(r.net.calls).toHaveLength(1);
        expect(r.net.calls[0]!.body).toMatchObject({
          op: "issue.comments",
          input: NOTES,
        });
      },
    ));

type Rig = Awaited<ReturnType<typeof rig>>;
/** A held write as the CLI makes it: a session, the caller's own context, and a generation only if the caller names one. */
const holding = (r: Rig, own: object = {}) => ({
  ...localContext(r.assembly, { kind: "agent", id: "a1" }, "s1"),
  ...own,
});
const edit = (
  r: Rig,
  op: string,
  context: object,
  dryRun = false,
  input: object = UPDATE,
  requestId?: string,
) =>
  dispatch(r.assembly.catalog, op, input, {
    caller: "agent",
    context,
    dryRun,
    ...(requestId === undefined ? {} : { requestId }),
  });
const sent = (r: Rig) => r.net.calls.map((c) => (c.body as { op: string }).op);
const live = () => answer({ ...ISSUE, lease: HELD });

/** The runtime's own preflight refusal, which a bound project reaches today (src/core/runtime/index.ts). */
const NO_CONTRACT = "this profile has no dry-run execution contract";
const REFUSED = (op: string) => ({
  ok: false,
  error: { code: "INPUT_INVALID", message: notServed(op) },
});
for (const dryRun of [false, true])
  test(`through the CLI discovery wrapper, issue board${dryRun ? " --dry-run" : ""} on a bound project is refused by name with no request`, () =>
    using({}, async (r) => {
      const done = await runCli(
        r.assembly.catalog,
        ["issue", "board", ...(dryRun ? ["--dry-run"] : [])],
        { caller: "agent", context: holding(r) },
      );
      expect(done.envelope).toMatchObject(REFUSED("issue.board"));
      expect(done.exitCode).toBe(6);
      expect(r.net.calls).toHaveLength(0);
    }));

/** The real identity resolver keeps its own refusal for a missing session or an invalid device, with no request, and a dry run stops at admission. */
for (const [name, own, dryRun, env, code, exit, text] of [
  ["no generation", {}, false, {}, "CONTEXT_MISSING", 6, "FORGE_SESSION"],
  [
    "an explicit generation",
    { leaseGeneration: 3 },
    false,
    {},
    "CONTEXT_MISSING",
    6,
    "FORGE_SESSION",
  ],
  ["a dry run", {}, true, {}, "UNAVAILABLE", 1, NO_CONTRACT],
  [
    "an invalid FORGE_DEVICE_ID",
    {},
    false,
    { FORGE_SESSION: "s1", FORGE_DEVICE_ID: "a b" },
    "CONTEXT_MISSING",
    6,
    "Invalid FORGE_DEVICE_ID",
  ],
] as const)
  test(`issue.link with ${name} and the real identity resolver keeps its own ${code} with no request`, () =>
    using({}, async (r) => {
      const result = await dispatch(r.assembly.catalog, "issue.link", LINK, {
        caller: "agent",
        context: {
          ...localContext(r.assembly, { kind: "agent", id: "a1" }),
          ...own,
        },
        resolveContext: localIdentityResolver(
          r.s.deviceRoot,
          { HOME: r.s.home, ...env },
          false,
        ),
        dryRun,
      });
      expect(failed(result, code)).toBe(exit);
      expect(JSON.stringify(result)).toContain(text);
      expect(r.net.calls).toHaveLength(0);
    }));

for (const [source, op] of [
  [WORK, "issue.update"],
  [RENAMED, "ticket.update"],
] as const)
  test(`through the assembled catalog, ${op} on a bound project takes the generation from the cloud show and is answered by the cloud as issue.update`, () =>
    using(
      { config: source, steps: [live, () => answer(UPDATED, "issue.update")] },
      async (r) => {
        const context = holding(r);
        const done = await edit(r, op, context);
        expect(done).toMatchObject({ ok: true, result: UPDATED });
        expect(exitCode(done)).toBe(0);
        expect(JSON.stringify(done)).not.toContain(TOKEN);
        expect(sent(r)).toEqual(["issue.show", "issue.update"]);
        expect(r.net.calls[1]!.body).toMatchObject({
          op: "issue.update",
          input: UPDATE,
          context: {
            actor: context.actor,
            session: context.session,
            leaseGeneration: 3,
            device: { id: "dev-1" },
          },
        });
      },
    ));

test("an explicit generation reaches the cloud unchanged, a stale one is refused there, and the CLI never reads or refreshes it", () =>
  using({ steps: [() => refusing("LEASE_STALE")] }, async (r) => {
    const stale = await edit(
      r,
      "issue.update",
      holding(r, { leaseGeneration: 2 }),
    );
    expect(failed(stale, "LEASE_STALE")).toBe(4);
    expect(sent(r)).toEqual(["issue.update"]);
    expect(r.net.calls[0]!.body).toMatchObject({
      context: { leaseGeneration: 2 },
    });
  }));

test("with no live lease in the cloud show the runtime's own CONTEXT_MISSING stands, and no update request is sent", () =>
  using({ steps: [() => answer()] }, async (r) => {
    const result = await edit(r, "issue.update", holding(r));
    expect(failed(result, "CONTEXT_MISSING")).toBe(6);
    expect(sent(r)).toEqual(["issue.show"]);
  }));

for (const [code, exit] of [
  ["REVISION_CONFLICT", 4],
  ["LEASE_NOT_HELD", 4],
  ["LEASE_EXPIRED", 4],
  ["AUTH_DEVICE_MISMATCH", 1],
] as const)
  test(`a cloud ${code} on issue.update keeps its code and exit ${exit}, without the token`, () =>
    using({ steps: [live, () => refusing(code)] }, async (r) => {
      expect(failed(await edit(r, "issue.update", holding(r)), code)).toBe(
        exit,
      );
      expect(sent(r)).toEqual(["issue.show", "issue.update"]);
    }));

test("a cloud issue.update result that fails TrackerItem is refused as UNAVAILABLE", () =>
  using(
    {
      steps: [
        live,
        () => answer({ ...UPDATED, revision: TOKEN }, "issue.update"),
      ],
    },
    async (r) => {
      const result = await edit(r, "issue.update", holding(r));
      expect(failed(result, "UNAVAILABLE")).toBe(1);
      expect(sent(r)).toEqual(["issue.show", "issue.update"]);
    },
  ));

test("issue.update through the CLI dispatch as a dry run is UNAVAILABLE and sends no update", () =>
  using({ steps: [live] }, async (r) => {
    const dry = await edit(r, "issue.update", holding(r), true);
    expect(failed(dry, "UNAVAILABLE")).toBe(1);
    expect(sent(r)).not.toContain("issue.update");
  }));

/** Requests are counted first: a refusal that came after a hidden cloud read is not the refusal this expects. */
const dryRefused = (r: Rig, result: Awaited<ReturnType<typeof edit>>) => {
  expect(r.net.calls).toHaveLength(0);
  expect(result).toMatchObject({
    error: { code: "UNAVAILABLE", message: NO_CONTRACT, retry: "never" },
  });
  expect(failed(result, "UNAVAILABLE")).toBe(1);
};
/** A bound dry run is refused at admission: not even the hidden show that fills a missing generation goes out. */
for (const op of [
  "issue.update",
  "issue.renew",
  "issue.release",
  "issue.dep",
  "issue.link",
  "issue.close",
])
  for (const [name, own] of [
    ["no generation", {}],
    ["an explicit generation", { leaseGeneration: 3 }],
  ] as const)
    test(`${op} as a dry run with ${name} on a bound project is refused before any cloud request`, () =>
      using({ steps: [live] }, async (r) => {
        dryRefused(r, await edit(r, op, holding(r, own), true, INPUTS[op]));
      }));

for (const [op, input] of [
  ["issue.show", { id: "forge-1" }],
  ["issue.comments", NOTES],
  ["issue.list", {}],
  ["issue.ready", {}],
] as const)
  test(`${op} as a dry run through dispatch on a bound project is refused before any cloud request`, () =>
    using({ steps: [() => answer(PAGE, op)] }, async (r) => {
      dryRefused(r, await edit(r, op, holding(r), true, input));
    }));

test("through MCP catalog_call and the direct tool, a held dry run on a bound project is refused before any cloud request", () =>
  using({ steps: [live] }, async (r) => {
    const context = holding(r);
    const expose = { expose: ["issue"] };
    const handlers = createMcpHandlers(r.assembly.catalog, expose, { context });
    dryRefused(
      r,
      (await handlers.callTool("catalog_call", {
        op: "issue.update",
        input: UPDATE,
        dryRun: true,
      }))!,
    );
    const direct = createMcpHandlers(r.assembly.catalog, expose, {
      context,
      dryRun: true,
    });
    dryRefused(
      r,
      (await direct.callTool(mcpToolName("issue.update")!, UPDATE))!,
    );
  }));

test("through the CLI wrapper, issue update --dry-run on a bound project is refused before any cloud request", () =>
  using({ steps: [live] }, async (r) => {
    const done = await runCli(
      r.assembly.catalog,
      ["issue", "update", "--input", JSON.stringify(UPDATE), "--dry-run"],
      { caller: "agent", context: holding(r) },
    );
    dryRefused(r, done.envelope);
    expect(done.exitCode).toBe(1);
  }));

for (const [op, input] of [
  ["issue.update", UPDATE],
  ["issue.link", LINK],
  ["issue.close", { id: "forge-1", withoutReceipt: "guard" }],
] as const)
  test(`${op} as a dry run on an unbound project is the local runtime's own refusal and sends no cloud request`, () =>
    using({ bind: false, creds: false, sentinel: false }, async (r) => {
      const result = await edit(r, op, holding(r), true, input);
      expect(result).toMatchObject({
        ok: false,
        status: "FAIL",
        error: { code: "UNAVAILABLE", message: NO_CONTRACT },
      });
      expect(exitCode(result)).toBe(1);
      expect(r.net.calls).toHaveLength(0);
    }));

const DEPPED = { ...ISSUE, dependsOn: ["forge-2"], revision: 4 };
const UNDEPPED = { ...ISSUE, revision: 4 };
const depends = (r: Rig, context: object, action = "add") =>
  edit(r, "issue.dep", context, false, { ...DEP, action });
const COMMAND = `${fx.ORIGIN}/p/${fx.PROJECT}/command`;
for (const [source, op, action, result] of [
  [WORK, "issue.dep", "add", DEPPED],
  [WORK, "issue.dep", "remove", UNDEPPED],
  [RENAMED, "ticket.dep", "add", DEPPED],
] as const)
  test(`through the assembled catalog, ${op} ${action} on a bound project takes the generation from the cloud show and is answered by the cloud as issue.dep`, () =>
    using(
      { config: source, steps: [live, () => answer(result, "issue.dep")] },
      async (r) => {
        const context = holding(r);
        // The caller's revision differs from the shown one (3), so a CLI that replaced it would fail.
        const input = { ...DEP, action, expectRevision: 7 };
        const done = await edit(r, op, context, false, input, "dep-1");
        expect(done).toMatchObject({ ok: true, result });
        expect(exitCode(done)).toBe(0);
        expect(JSON.stringify(done)).not.toContain(TOKEN);
        expect(sent(r)).toEqual(["issue.show", "issue.dep"]);
        expect(r.net.calls[1]!.url).toBe(COMMAND);
        expect(r.net.calls[1]!.body).toEqual({
          requestId: "dep-1",
          op: "issue.dep",
          input,
          context: {
            actor: context.actor,
            session: context.session,
            leaseGeneration: 3,
            device: { id: "dev-1" },
            project: { id: fx.PROJECT },
          },
        });
      },
    ));

test("an explicit generation on issue.dep reaches the cloud unchanged, a stale one is refused there, and the CLI never reads or refreshes it", () =>
  using({ steps: [() => refusing("LEASE_STALE")] }, async (r) => {
    const context = holding(r, { leaseGeneration: 2 });
    const input = { ...DEP, expectRevision: 7 };
    const stale = await edit(r, "issue.dep", context, false, input, "dep-2");
    expect(failed(stale, "LEASE_STALE")).toBe(4);
    expect(sent(r)).toEqual(["issue.dep"]);
    expect(r.net.calls[0]!.url).toBe(COMMAND);
    expect(r.net.calls[0]!.body).toEqual({
      requestId: "dep-2",
      op: "issue.dep",
      input,
      context: {
        actor: context.actor,
        session: context.session,
        leaseGeneration: 2,
        device: { id: "dev-1" },
        project: { id: fx.PROJECT },
      },
    });
  }));

test("with no live lease in the cloud show the runtime's own CONTEXT_MISSING stands for issue.dep, and no dep request is sent", () =>
  using({ steps: [() => answer()] }, async (r) => {
    const result = await depends(r, holding(r));
    expect(failed(result, "CONTEXT_MISSING")).toBe(6);
    expect(sent(r)).toEqual(["issue.show"]);
  }));

for (const [code, exit] of [
  ["NOT_FOUND", 3],
  ["INPUT_CONFLICT", 4],
  ["INPUT_INVALID", 6],
  ["REVISION_CONFLICT", 4],
  ["LEASE_NOT_HELD", 4],
  ["AUTH_DEVICE_MISMATCH", 1],
] as const)
  test(`a cloud ${code} on issue.dep keeps its code and exit ${exit}, without the token`, () =>
    using({ steps: [live, () => refusing(code)] }, async (r) => {
      expect(failed(await depends(r, holding(r)), code)).toBe(exit);
      expect(sent(r)).toEqual(["issue.show", "issue.dep"]);
    }));

test("a cloud issue.dep result that fails TrackerItem is refused as UNAVAILABLE", () =>
  using(
    {
      steps: [live, () => answer({ ...DEPPED, revision: TOKEN }, "issue.dep")],
    },
    async (r) => {
      const result = await depends(r, holding(r));
      expect(failed(result, "UNAVAILABLE")).toBe(1);
      expect(sent(r)).toEqual(["issue.show", "issue.dep"]);
    },
  ));

const link = (r: Rig, context: object, requestId = "link-1") =>
  edit(r, "issue.link", context, false, LINK, requestId);
const linkBody = (
  context: ReturnType<typeof holding>,
  leaseGeneration: number,
  requestId: string,
) => ({
  requestId,
  op: "issue.link",
  input: LINK,
  context: {
    actor: context.actor,
    session: context.session,
    leaseGeneration,
    device: { id: "dev-1" },
    project: { id: fx.PROJECT },
  },
});
for (const [source, op] of [
  [WORK, "issue.link"],
  [RENAMED, "ticket.link"],
] as const)
  test(`through the assembled catalog, ${op} on a bound project takes the generation from the cloud show and returns the cloud's whole record as issue.link`, () =>
    using(
      { config: source, steps: [live, () => answer(LINKED, "issue.link")] },
      async (r) => {
        const context = holding(r);
        const done = await edit(r, op, context, false, LINK, "link-1");
        expect(done).toMatchObject({ ok: true, op });
        expect((done as unknown as { result: object }).result).toEqual(LINKED);
        expect(exitCode(done)).toBe(0);
        expect(JSON.stringify(done)).not.toContain(TOKEN);
        expect(sent(r)).toEqual(["issue.show", "issue.link"]);
        expect(r.net.calls[1]!.url).toBe(COMMAND);
        expect(r.net.calls[1]!.body).toEqual(linkBody(context, 3, "link-1"));
      },
    ));

test("an explicit generation on issue.link reaches the cloud unchanged, a stale one is refused there, and the CLI never reads or refreshes it", () =>
  using({ steps: [() => refusing("LEASE_STALE")] }, async (r) => {
    const context = holding(r, { leaseGeneration: 2 });
    expect(failed(await link(r, context, "link-2"), "LEASE_STALE")).toBe(4);
    expect(sent(r)).toEqual(["issue.link"]);
    expect(r.net.calls[0]!.url).toBe(COMMAND);
    expect(r.net.calls[0]!.body).toEqual(linkBody(context, 2, "link-2"));
  }));

test("with no live lease in the cloud show the runtime's own CONTEXT_MISSING stands for issue.link, and no link request is sent", () =>
  using({ steps: [() => answer()] }, async (r) => {
    expect(failed(await link(r, holding(r)), "CONTEXT_MISSING")).toBe(6);
    expect(sent(r)).toEqual(["issue.show"]);
  }));

for (const [code, exit] of [
  ["INPUT_INVALID", 6],
  ["CONTEXT_MISSING", 6],
  ["NOT_FOUND", 3],
  ["UNKNOWN_COMMAND", 3],
  ["INPUT_CONFLICT", 4],
  ["REVISION_CONFLICT", 4],
  ["LEASE_NOT_HELD", 4],
  ["LEASE_EXPIRED", 4],
  ["INTERNAL", 1],
  ["AUTH_REVOKED", 1],
  ["AUTH_DEVICE_MISMATCH", 1],
] as const)
  test(`a cloud ${code} on issue.link keeps its code and exit ${exit}, without the token`, () =>
    using({ steps: [live, () => refusing(code)] }, async (r) => {
      expect(failed(await link(r, holding(r)), code)).toBe(exit);
      expect(sent(r)).toEqual(["issue.show", "issue.link"]);
    }));

for (const [name, bad] of [
  ["a token in the revision", { ...LINKED, revision: TOKEN }],
  ["an issue instead of a record", { ...ISSUE, extra: TOKEN }],
] as const)
  test(`a cloud issue.link result with ${name} fails its declared output and is refused as UNAVAILABLE`, () =>
    using({ steps: [live, () => answer(bad, "issue.link")] }, async (r) => {
      expect(failed(await link(r, holding(r)), "UNAVAILABLE")).toBe(1);
      expect(sent(r)).toEqual(["issue.show", "issue.link"]);
    }));

/** The same link as the CLI wrapper makes it and as MCP catalog_call makes it, each with its rendered output. */
const through = async (
  r: Rig,
  surface: "CLI" | "MCP",
  context: ReturnType<typeof holding>,
  dryRun = false,
) => {
  if (surface === "CLI") {
    const argv = ["issue", "link", "--input", JSON.stringify(LINK)];
    return runCli(r.assembly.catalog, dryRun ? [...argv, "--dry-run"] : argv, {
      caller: "agent",
      context,
    });
  }
  const mcp = createMcpHandlers(
    r.assembly.catalog,
    { expose: ["issue"] },
    { context },
  );
  const args = { op: "issue.link", input: LINK, ...(dryRun ? { dryRun } : {}) };
  return respond((await mcp.callTool("catalog_call", args))!);
};
for (const surface of ["CLI", "MCP"] as const) {
  for (const [mode, own] of [
    ["no generation", {}],
    ["an explicit generation", { leaseGeneration: 3 }],
  ] as const)
    test(`through ${surface}, issue link as a dry run with ${mode} on a bound project is refused before any cloud request`, () =>
      using({ steps: [live] }, async (r) => {
        const done = await through(r, surface, holding(r, own), true);
        dryRefused(r, done.envelope);
        expect(done.exitCode).toBe(1);
      }));

  test(`through ${surface}, issue link on a bound project returns the cloud's whole record from one show and one link command`, () =>
    using({ steps: [live, () => answer(LINKED, "issue.link")] }, async (r) => {
      const context = holding(r);
      const done = await through(r, surface, context);
      expect(done.envelope).toMatchObject({ ok: true, op: "issue.link" });
      expect((done.envelope as { result: object }).result).toEqual(LINKED);
      expect(done.exitCode).toBe(0);
      expect(done.stdout).not.toContain(TOKEN);
      expect(sent(r)).toEqual(["issue.show", "issue.link"]);
      expect(r.net.calls[1]!.url).toBe(COMMAND);
      expect(r.net.calls[1]!.body).toEqual(
        linkBody(context, 3, expect.any(String) as unknown as string),
      );
    }));

  for (const [what, step, code, exit] of [
    ["a cloud refusal", () => refusing("INPUT_INVALID"), "INPUT_INVALID", 6],
    [
      "a malformed record",
      () => answer({ ...LINKED, revision: TOKEN }, "issue.link"),
      "UNAVAILABLE",
      1,
    ],
  ] as const)
    test(`through ${surface}, issue link with ${what} carrying the token keeps ${code} and leaks no token into the envelope or stdout`, () =>
      using({ steps: [live, step] }, async (r) => {
        const done = await through(r, surface, holding(r));
        expect(done.envelope).toMatchObject({ ok: false, error: { code } });
        expect(done.exitCode).toBe(exit);
        expect(JSON.stringify(done.envelope)).not.toContain(TOKEN);
        expect(done.stdout).not.toContain(TOKEN);
        expect(sent(r)).toEqual(["issue.show", "issue.link"]);
      }));
}

const CLOSED = { ...ISSUE, status: "closed", revision: 4 };
const closes = (r: Rig, context: object, input: object = CLOSE) =>
  edit(r, "issue.close", context, false, input);
for (const [source, op] of [
  [WORK, "issue.close"],
  [RENAMED, "ticket.close"],
] as const)
  test(`through the assembled catalog, ${op} on a bound project takes the generation from the cloud show and is answered by the cloud as issue.close`, () =>
    using(
      { config: source, steps: [live, () => answer(CLOSED, "issue.close")] },
      async (r) => {
        const context = holding(r);
        const done = await edit(r, op, context, false, CLOSE, "close-1");
        expect(done).toMatchObject({ ok: true, result: CLOSED });
        expect(exitCode(done)).toBe(0);
        expect(JSON.stringify(done)).not.toContain(TOKEN);
        expect(sent(r)).toEqual(["issue.show", "issue.close"]);
        expect(r.net.calls[1]!.url).toBe(COMMAND);
        expect(r.net.calls[1]!.body).toEqual({
          requestId: "close-1",
          op: "issue.close",
          input: CLOSE,
          context: {
            actor: context.actor,
            session: context.session,
            leaseGeneration: 3,
            device: { id: "dev-1" },
            project: { id: fx.PROJECT },
          },
        });
      },
    ));

test("an explicit generation on issue.close reaches the cloud unchanged, a stale one is refused there, and the CLI never reads or refreshes it", () =>
  using({ steps: [() => refusing("LEASE_STALE")] }, async (r) => {
    const context = holding(r, { leaseGeneration: 2 });
    const stale = await edit(
      r,
      "issue.close",
      context,
      false,
      CLOSE,
      "close-2",
    );
    expect(failed(stale, "LEASE_STALE")).toBe(4);
    expect(sent(r)).toEqual(["issue.close"]);
    expect(r.net.calls[0]!.url).toBe(COMMAND);
    expect(r.net.calls[0]!.body).toEqual({
      requestId: "close-2",
      op: "issue.close",
      input: CLOSE,
      context: {
        actor: context.actor,
        session: context.session,
        leaseGeneration: 2,
        device: { id: "dev-1" },
        project: { id: fx.PROJECT },
      },
    });
  }));

test("with no live lease in the cloud show the runtime's own CONTEXT_MISSING stands for issue.close, and no close request is sent", () =>
  using({ steps: [() => answer()] }, async (r) => {
    const result = await closes(r, holding(r));
    expect(failed(result, "CONTEXT_MISSING")).toBe(6);
    expect(sent(r)).toEqual(["issue.show"]);
  }));

const RECEIPT = { id: "forge-1", receipt: "proof-1" };
for (const [name, own] of [
  ["no generation", {}],
  ["an explicit generation", { leaseGeneration: 3 }],
] as const)
  for (const [shape, input] of [
    ["only a receipt", RECEIPT],
    ["a receipt and withoutReceipt", { ...CLOSE, ...RECEIPT }],
  ] as const)
    test(`issue.close with ${shape} and ${name} on a bound project is INPUT_INVALID before any request, the hidden show included`, () =>
      using({ steps: [live] }, async (r) => {
        const result = await closes(r, holding(r, own), input);
        expect(failed(result, "INPUT_INVALID")).toBe(6);
        expect(result).toMatchObject({
          error: {
            message:
              "issue.close with a receipt is not supported in cloud yet.",
          },
        });
        expect(r.net.calls).toHaveLength(0);
      }));

test("a receipt on issue.close that reaches the selector directly is refused before any request", () =>
  using({}, async (r) => {
    const result = await r.assembly.catalog.invoke(
      r.request(
        "issue.close",
        { ...CLOSE, ...RECEIPT },
        {
          context: holding(r, { leaseGeneration: 3 }),
        },
      ),
    );
    expect(failed(result, "INPUT_INVALID")).toBe(6);
    expect(result).toMatchObject({
      error: {
        message: "issue.close with a receipt is not supported in cloud yet.",
      },
    });
    expect(r.net.calls).toHaveLength(0);
  }));

/** A caller that forwards admit only three arguments: the input is lost, and the refusal must still come before any request. */
const droppingInput = (r: Rig) => ({
  ...r.assembly.catalog,
  admit: (blockId: string, op: string, dryRun: boolean | undefined) =>
    r.assembly.catalog.admit!(blockId, op, dryRun, undefined),
});
for (const [op, input] of [
  ["issue.close", { ...CLOSE, ...RECEIPT }],
  ["issue.close", CLOSE],
  ["issue.link", LINK],
] as const)
  test(`${op} with ${"receipt" in input ? "a receipt" : "withoutReceipt" in input ? "withoutReceipt" : "a valid link"} whose input is dropped before admission is refused before any request, through dispatch and MCP`, () =>
    using({ steps: [live] }, async (r) => {
      const catalog = droppingInput(r);
      const context = holding(r);
      const refused = (result: Awaited<ReturnType<typeof edit>>) => {
        expect(failed(result, "INPUT_INVALID")).toBe(6);
        expect(result).toMatchObject({
          error: {
            message: `${op} was not given its input to check before a cloud request.`,
          },
        });
        expect(r.net.calls).toHaveLength(0);
      };
      refused(
        await dispatch(catalog, op, input, {
          caller: "agent",
          context,
        }),
      );
      const handlers = createMcpHandlers(
        catalog,
        { expose: ["issue"] },
        { context },
      );
      refused(
        (await handlers.callTool("catalog_call", {
          op,
          input,
        }))!,
      );
    }));

for (const [code, exit] of [
  ["RECEIPT_REQUIRED", 1],
  ["INPUT_CONFLICT", 4],
  ["NOT_FOUND", 3],
  ["LEASE_NOT_HELD", 4],
  ["AUTH_DEVICE_MISMATCH", 1],
] as const)
  test(`a cloud ${code} on issue.close keeps its code and exit ${exit}, without the token`, () =>
    using({ steps: [live, () => refusing(code)] }, async (r) => {
      expect(failed(await closes(r, holding(r)), code)).toBe(exit);
      expect(sent(r)).toEqual(["issue.show", "issue.close"]);
    }));

test("a cloud issue.close result that fails TrackerItem is refused as UNAVAILABLE", () =>
  using(
    {
      steps: [
        live,
        () => answer({ ...CLOSED, revision: TOKEN }, "issue.close"),
      ],
    },
    async (r) => {
      const result = await closes(r, holding(r));
      expect(failed(result, "UNAVAILABLE")).toBe(1);
      expect(sent(r)).toEqual(["issue.show", "issue.close"]);
    },
  ));

const ITEM = { id: "forge-1" };
const GRANT = { ...ITEM, generation: 3, expiresAt: iso(NOW + 3_600_000) };
const act = (
  r: Rig,
  op: string,
  input: object,
  context: object,
  options: { dryRun?: boolean; requestId?: string } = {},
) =>
  dispatch(r.assembly.catalog, op, input, {
    caller: "agent",
    context,
    ...options,
  });
const wire = (r: Rig) =>
  r.net.calls.map((c) => c.url.slice(c.url.lastIndexOf("/") + 1));
const NOUNS = [
  [WORK, "issue"],
  [RENAMED, "ticket"],
] as const;

for (const [source, noun] of NOUNS)
  test(`through the assembled catalog, ${noun}.claim on a bound project is answered by the cloud as issue.claim with the caller's session, actor and device`, () =>
    using(
      { config: source, steps: [() => answer(GRANT, "issue.claim")] },
      async (r) => {
        const context = holding(r);
        const done = await act(r, `${noun}.claim`, ITEM, context);
        expect(done).toMatchObject({ ok: true });
        expect((done as unknown as { result: object }).result).toEqual(GRANT);
        expect(exitCode(done)).toBe(0);
        expect(JSON.stringify(done)).not.toContain(TOKEN);
        expect(wire(r)).toEqual(["command"]);
        const body = r.net.calls[0]!.body as { input: object };
        expect(body.input).toEqual(ITEM);
        expect(body).toMatchObject({
          op: "issue.claim",
          context: {
            actor: context.actor,
            session: context.session,
            device: { id: "dev-1" },
          },
        });
      },
    ));

for (const [code, exit] of [
  ["LEASE_HELD", 4],
  ["CLAIM_BLOCKED", 1],
  ["INPUT_CONFLICT", 4],
  ["NOT_FOUND", 3],
] as const)
  test(`a cloud ${code} on issue.claim keeps its code and exit ${exit}, without the token`, () =>
    using({ steps: [() => refusing(code)] }, async (r) => {
      const result = await act(r, "issue.claim", ITEM, holding(r));
      expect(failed(result, code)).toBe(exit);
      expect(wire(r)).toEqual(["command"]);
    }));

/** The local lease engine's own refusal for the same subject and holder: the oracle for the cloud's. */
function localRefusal(current: LeaseRecord | undefined, generation = 3) {
  const decision = decideLease(current, {
    mode: generation === 0 ? "acquire" : "held",
    subject: current?.subject ?? "issue:work-1",
    holder: { actor: { kind: "agent", id: "a1" }, session: { id: "s1" } },
    nowMs: NOW,
    generation,
  });
  if (decision.ok) throw new Error("the local engine granted the lease");
  return decision.error;
}
const claimVia = (r: Rig, noun: string, id: string, text: boolean) =>
  runCli(
    r.assembly.catalog,
    [
      noun,
      "claim",
      "--input",
      JSON.stringify({ id }),
      text ? "--text" : "--json",
    ],
    { caller: "agent", context: holding(r) },
  );
const errorOf = (done: { envelope: unknown }) =>
  (done.envelope as { error: object }).error;

for (const [source, noun, ids] of [
  [WORK, "issue", ["forge-0007", "work-0007", "FORGE-0007", "legacy-0007"]],
  [RENAMED, "ticket", ["forge-0007"]],
] as const)
  test(`${noun}.claim for ${ids.join(", ")} lost to another holder shows that holder in --json and --text exactly as the local engine refuses, with exit 4 and no local state`, () =>
    using(
      {
        config: source,
        steps: [() => refusing("LEASE_HELD", { lease: heldBy("0007") })],
      },
      async (r) => {
        const want = localRefusal(heldBy("0007"), 0);
        expect(want.code).toBe("LEASE_HELD");
        let sent = 0;
        for (const id of ids)
          for (const text of [false, true]) {
            const done = await claimVia(r, noun, id, text);
            expect(errorOf(done)).toEqual(want);
            expect(done.stdout).toBe(
              respond(
                { ...(done.envelope as FailureEnvelope), error: want },
                text,
              ).stdout,
            );
            for (const shown of ["dev-9", "a2", "claude", "s9", "0007"])
              expect(done.stdout).toContain(shown);
            expect(done.stdout).toContain(heldBy().expiresAt);
            expect(done.exitCode).toBe(4);
            expect(done.stdout).not.toContain(TOKEN);
            expect(wire(r)).toHaveLength(++sent);
            expect(new Set(wire(r))).toEqual(new Set(["command"]));
            expect(r.net.calls.at(-1)!.body).toMatchObject({
              op: "issue.claim",
              input: { id },
            });
          }
      },
    ));

test("a fresh checkout in another home with its own credential names the same holder, and creates no local store", async () => {
  const outputs: string[] = [];
  const visit = () =>
    using({ steps: [() => refusing("LEASE_HELD")] }, async (r) => {
      const before = readdirSync(join(r.s.root, ".forge")).sort();
      const done = await claimVia(r, "issue", "forge-1", true);
      expect(done.exitCode).toBe(4);
      outputs.push(done.stdout);
      expect(readdirSync(join(r.s.root, ".forge")).sort()).toEqual(before);
      expect(wire(r)).toEqual(["command"]);
    });
  await visit();
  await visit();
  expect(outputs[1]).toBe(outputs[0]);
  expect(outputs[0]).toContain("id: s9");
});

const lapsedBy = (digits = "1") => ({
  ...heldBy(digits),
  expiresAt: iso(NOW - 1),
});
for (const [code, current, generation] of [
  ["LEASE_STALE", heldBy(), 3],
  ["LEASE_NOT_HELD", undefined, 3],
  ["LEASE_NOT_HELD", heldBy(), 4],
  [
    "LEASE_EXPIRED",
    {
      ...lapsedBy(),
      holder: {
        ...CLOUD_HOLDER,
        session: { id: "s1" },
        actor: { kind: "agent", id: "a1" },
      },
    },
    4,
  ],
] as const)
  test(`a cloud ${code} on issue.claim${current === undefined ? " with only a subject" : ""} keeps the local engine's code, retry posture and lease, with exit 4`, () => {
    const want = localRefusal(current, generation);
    return using(
      { steps: [() => refusing(code, { lease: want.lease })] },
      async (r) => {
        const done = await claimVia(r, "issue", "forge-1", false);
        expect(want.code).toBe(code);
        const got = errorOf(done) as typeof want;
        expect([got.code, got.retry, got.lease]).toEqual([
          want.code,
          want.retry,
          want.lease,
        ]);
        expect(done.exitCode).toBe(4);
        expect(wire(r)).toEqual(["command"]);
      },
    );
  });

for (const text of [false, true])
  test(`a cloud CLAIM_BLOCKED shows exactly the blocker edges in ${text ? "--text" : "--json"} with exit 1, no invented state and no --reason repair`, () =>
    using({ steps: [() => refusing("CLAIM_BLOCKED")] }, async (r) => {
      const done = await claimVia(r, "issue", "forge-1", text);
      const error = errorOf(done) as { observed?: unknown; repair?: string };
      expect(error.observed).toEqual({ blockers: BLOCKERS });
      expect(error.repair).toBeUndefined();
      expect(done.exitCode).toBe(1);
      for (const shown of ["forge-2", "forge-3", "s9", "dev-9"])
        expect(done.stdout).toContain(shown);
      expect(done.stdout).not.toMatch(/--reason|\bopen\b|\bmissing\b/);
      expect(done.stdout).not.toContain(TOKEN);
      expect(wire(r)).toEqual(["command"]);
    }));

const hostile = (value: string) => ({
  lease: {
    ...heldBy(),
    holder: {
      ...CLOUD_HOLDER,
      session: { ...CLOUD_HOLDER.session, agent: value },
    },
  },
});
for (const [name, extra] of [
  ["a lease that is absent", {}],
  ["a subject-only lease", { lease: { subject: "issue:work-1" } }],
  ["another issue's subject", { lease: heldBy("2") }],
  ["the presented token in the holder", hostile(TOKEN)],
  [
    "a foreign device token in the holder",
    hostile(`fct_ffffffffffffffff.${"Z".repeat(43)}`),
  ],
] as const)
  test(`a cloud LEASE_HELD with ${name} is refused as UNAVAILABLE with exit 1, nothing partial and no local state`, () =>
    using({ steps: [() => refusing("LEASE_HELD", extra)] }, async (r) => {
      for (const text of [false, true]) {
        const done = await claimVia(r, "issue", "forge-1", text);
        expect(errorOf(done)).toMatchObject({ code: "UNAVAILABLE" });
        expect(done.exitCode).toBe(1);
        expect(done.stdout).not.toMatch(/dev-9|s9|fct_/);
      }
      expect(wire(r)).toEqual(["command", "command"]);
    }));

test("a cloud CLAIM_BLOCKED with an invented state is refused as UNAVAILABLE, and a valid refusal survives token text in the fields it discards", () =>
  using(
    {
      steps: [
        () =>
          refusing("CLAIM_BLOCKED", {
            observed: { blockers: [{ id: "forge-2", state: "open" }] },
          }),
        () =>
          refusing("LEASE_HELD", {
            lease: heldBy(),
            expected: TOKEN,
            hint: { template: TOKEN, command: TOKEN },
            details: { token: TOKEN },
            repair: TOKEN,
          }),
      ],
    },
    async (r) => {
      const blocked = await claimVia(r, "issue", "forge-1", false);
      expect(errorOf(blocked)).toMatchObject({ code: "UNAVAILABLE" });
      expect(blocked.exitCode).toBe(1);
      const held = await claimVia(r, "issue", "forge-1", true);
      expect(errorOf(held)).toMatchObject({
        code: "LEASE_HELD",
        lease: heldBy(),
      });
      expect(held.exitCode).toBe(4);
      expect(held.stdout).not.toContain(TOKEN);
    },
  ));

for (const extra of [{ reopen: "why" }, { reason: "why" }])
  test(`issue.claim with ${Object.keys(extra)[0]} on a bound project is INPUT_INVALID with no request`, () =>
    using({}, async (r) => {
      const result = await act(
        r,
        "issue.claim",
        { ...ITEM, ...extra },
        holding(r),
      );
      expect(failed(result, "INPUT_INVALID")).toBe(6);
      expect(
        (result as { error: { message: string } }).error.message,
      ).toContain("not supported in cloud yet");
      expect(r.net.calls).toHaveLength(0);
    }));

test("a cloud issue.claim result that fails its declared output is refused as UNAVAILABLE", () =>
  using(
    { steps: [() => answer({ ...GRANT, generation: TOKEN }, "issue.claim")] },
    async (r) => {
      const result = await act(r, "issue.claim", ITEM, holding(r));
      expect(failed(result, "UNAVAILABLE")).toBe(1);
      expect(wire(r)).toEqual(["command"]);
    },
  ));

const SHORT = { ...GRANT, expiresAt: iso(NOW + 120_000) };
const ENDS = [
  {
    name: "renew",
    input: ITEM,
    result: GRANT,
    bad: { ...GRANT, generation: TOKEN },
  },
  {
    name: "release",
    input: ITEM,
    result: ITEM,
    bad: { ...ITEM, extra: TOKEN },
  },
] as const;

for (const [source, noun] of NOUNS)
  for (const t of [
    ...ENDS,
    { ...ENDS[0], input: { ...ITEM, ttlSeconds: 120 }, result: SHORT },
  ])
    test(`through the assembled catalog, ${noun}.${t.name} ${JSON.stringify(t.input)} on a bound project takes the generation from the cloud show and is one issue.${t.name} command with the caller's session, actor and device`, () =>
      using(
        {
          config: source,
          steps: [live, () => answer(t.result, `issue.${t.name}`)],
        },
        async (r) => {
          const context = holding(r);
          const done = await act(r, `${noun}.${t.name}`, t.input, context);
          expect((done as unknown as { result: object }).result).toEqual(
            t.result,
          );
          expect(exitCode(done)).toBe(0);
          expect(JSON.stringify(done)).not.toContain(TOKEN);
          expect(wire(r)).toEqual(["command", "command"]);
          expect(sent(r)).toEqual(["issue.show", `issue.${t.name}`]);
          const body = r.net.calls[1]!.body as { input: object };
          expect(body.input).toEqual(t.input);
          expect(body).not.toHaveProperty("subject");
          expect(body).toMatchObject({
            context: {
              actor: context.actor,
              session: context.session,
              leaseGeneration: 3,
              device: { id: "dev-1" },
            },
          });
        },
      ));

for (const t of ENDS)
  test(`${t.name} with an explicit generation 2 while the cloud is at 3 sends 2 and returns the cloud's LEASE_STALE, with no show`, () =>
    using({ steps: [() => refusing("LEASE_STALE")] }, async (r) => {
      const own = holding(r, { leaseGeneration: 2 });
      const result = await act(r, `issue.${t.name}`, t.input, own);
      expect(failed(result, "LEASE_STALE")).toBe(4);
      expect(sent(r)).toEqual([`issue.${t.name}`]);
      expect(r.net.calls[0]!.body).toMatchObject({
        context: { leaseGeneration: 2 },
      });
    }));

for (const t of ENDS)
  test(`${t.name} with no live lease in the cloud show is the runtime's CONTEXT_MISSING and sends no ${t.name} command`, () =>
    using({ steps: [() => answer()] }, async (r) => {
      const result = await act(r, `issue.${t.name}`, t.input, holding(r));
      expect(failed(result, "CONTEXT_MISSING")).toBe(6);
      expect(sent(r)).toEqual(["issue.show"]);
    }));

for (const [code, exit] of [
  ["LEASE_NOT_HELD", 4],
  ["LEASE_EXPIRED", 4],
  ["NOT_FOUND", 3],
  ["AUTH_DEVICE_MISMATCH", 1],
] as const)
  for (const t of ENDS)
    test(`a cloud ${code} on issue.${t.name} keeps its code and exit ${exit}, without the token`, () =>
      using({ steps: [live, () => refusing(code)] }, async (r) => {
        const result = await act(r, `issue.${t.name}`, t.input, holding(r));
        expect(failed(result, code)).toBe(exit);
        expect(sent(r)).toEqual(["issue.show", `issue.${t.name}`]);
      }));

for (const t of ENDS)
  test(`a cloud issue.${t.name} result that fails its declared output is refused as UNAVAILABLE`, () =>
    using(
      { steps: [live, () => answer(t.bad, `issue.${t.name}`)] },
      async (r) => {
        const result = await act(r, `issue.${t.name}`, t.input, holding(r));
        expect(failed(result, "UNAVAILABLE")).toBe(1);
        expect(sent(r)).toEqual(["issue.show", `issue.${t.name}`]);
      },
    ));

test("an outage is UNAVAILABLE and never a local read", () =>
  using(
    {
      steps: [
        () => {
          throw new Error("down");
        },
      ],
    },
    async (r) => {
      expect(failed(await show(r), "UNAVAILABLE")).toBe(1);
      expect(r.net.calls).toHaveLength(1);
    },
  ));

for (const [name, creds] of [
  ["is missing", false],
  ["expired", { expiresAt: iso(NOW - 1) }],
  ["belongs to another server", { origin: fx.OTHER_ORIGIN }],
] as const)
  test(`a stored credential that ${name} gives AUTH_REQUIRED with no request`, () =>
    using({ creds }, async (r) => {
      expect(failed(await show(r), "AUTH_REQUIRED")).toBe(1);
      expect(r.net.calls).toHaveLength(0);
    }));

test("a corrupt credential store keeps ACCOUNT_INTEGRITY with no request", () =>
  using({}, async (r) => {
    writeFileSync(r.s.credentials, "{");
    expect(failed(await show(r), "ACCOUNT_INTEGRITY")).toBe(1);
    expect(r.net.calls).toHaveLength(0);
  }));

for (const code of ["AUTH_REVOKED", "AUTH_EXPIRED", "AUTH_INVALID"])
  test(`a server ${code} keeps its code, with the server's text left out`, () =>
    using({ steps: [() => refusing(code)] }, async (r) => {
      expect(failed(await show(r), code)).toBe(1);
      expect(r.net.calls).toHaveLength(1);
    }));

test("a missing device is refused and none is created; a different device is refused with no request", () =>
  using({ device: false }, async (r) => {
    expect(failed(await show(r), "CONTEXT_MISSING")).toBe(6);
    expect(existsSync(r.s.deviceRoot)).toBe(false);
    expect(r.net.calls).toHaveLength(0);
    await using({ device: "other-device" }, async (other) => {
      expect(failed(await show(other), "AUTH_DEVICE_MISMATCH")).toBe(1);
      expect(other.net.calls).toHaveLength(0);
    });
  }));

const showWith = (r: Awaited<ReturnType<typeof rig>>, own: object) =>
  r.assembly.catalog.invoke(
    r.request(
      "issue.show",
      { id: "forge-1" },
      {
        context: { ...r.request("x", {}).context, ...own },
      },
    ),
  );
const wired = wireDeviceId("my laptop");

test("only this machine's device is accepted in the context, and only this machine's device is sent", () =>
  using({ device: "my laptop", creds: { device: wired } }, async (r) => {
    expect(await showWith(r, { device: { id: wired } })).toMatchObject({
      ok: true,
    });
    expect(r.net.calls[0]!.body).toMatchObject({
      context: { device: { id: wired } },
    });
    const foreign = await showWith(r, { device: { id: "foreign" } });
    expect(failed(foreign, "AUTH_DEVICE_MISMATCH")).toBe(1);
    expect(r.net.calls).toHaveLength(1);
  }));

test("a device that matches the credential but not this machine is refused with no request", () =>
  using({ device: "other-device" }, async (r) => {
    const spoof = await showWith(r, { device: { id: "dev-1" } });
    expect(failed(spoof, "AUTH_DEVICE_MISMATCH")).toBe(1);
    expect(r.net.calls).toHaveLength(0);
  }));

test("a context for another project is the runtime's INPUT_CONFLICT with no request", () =>
  using({}, async (r) => {
    const project = { id: fx.OTHER_PROJECT_ID, root: r.s.root };
    const result = await showWith(r, { project });
    expect(failed(result, "INPUT_CONFLICT")).toBe(4);
    expect(result).toMatchObject({
      error: { message: "State context belongs to another project" },
    });
    expect(r.net.calls).toHaveLength(0);
  }));

const manifest = (s: fx.Sandbox) => join(s.root, ".forge", "project.json");
const dropped = (s: fx.Sandbox) => rmSync(manifest(s));
const linked = (s: fx.Sandbox) => (
  rmSync(s.binding),
  symlinkSync(manifest(s), s.binding)
);
type Store = { entries: Record<string, unknown> };
const another = (s: fx.Sandbox) => {
  const files = openCloudFiles(s.home); // the store's own private write, so the file keeps its protection
  const file = JSON.parse(files.read(CREDENTIAL_FILE)!) as Store;
  const id = "b".repeat(16); // the token must carry its own id, or the store refuses the whole file
  const token = fx.tokenFor(id, "P".repeat(43));
  const e = fx.entry(NOW, { origin: fx.OTHER_ORIGIN, id, token });
  file.entries[`${e.origin}|${e.identity}|${e.project}`] = e;
  files.write(CREDENTIAL_FILE, JSON.stringify(file));
};
const BAD = "INPUT_INVALID";
const CLASH = "INPUT_CONFLICT";
const lapsed = { expiresAt: iso(NOW - fx.DAY) };
const extra = JSON.stringify({ ...fx.bindingFor(), x: 1 });
const other = { identity: fx.OTHER_PROJECT_ID };
const rows: [string, Setup, string][] = [
  ["a malformed binding", { bind: "{" }, BAD],
  ["a binding with an extra key", { bind: extra }, BAD],
  ["a binding for another identity", { bind: other }, CLASH],
  ["a binding with no manifest", { prepare: dropped }, "CONTEXT_MISSING"],
  ["a remembered credential, no binding", { bind: false }, CLASH],
  ["an expired one, no binding", { bind: false, creds: lapsed }, CLASH],
  ["credentials for two servers", { bind: false, prepare: another }, CLASH],
];
if (process.platform !== "win32")
  rows.push(["a symlinked binding", { prepare: linked }, BAD]);
for (const [name, setup, code] of rows)
  test(`${name} is refused before any local state or request`, () =>
    using(setup, async (r) => {
      failed(await show(r), code);
      expect(r.net.calls).toHaveLength(0);
    }));

test("a direct issue show --dry-run is UNAVAILABLE with no request", () =>
  using({}, async (r) => {
    const dry = r.request("issue.show", { id: "forge-1" }, { dryRun: true });
    expect(failed(await r.assembly.catalog.invoke(dry), "UNAVAILABLE")).toBe(1);
    expect(r.net.calls).toHaveLength(0);
  }));

/** A committed checkout with a linked worktree beside it; returns the worktree's path. */
function addWorktree(s: fx.Sandbox): string {
  const linked = join(s.dir, "linked");
  for (const args of [
    ["init", "--quiet"],
    ["add", "-A"],
    ["commit", "--quiet", "-m", "p"],
    ["worktree", "add", "--quiet", linked],
  ]) {
    const git = ["-c", "user.name=t", "-c", "user.email=t@example.test"];
    const run = spawnSync("git", [...git, ...args], {
      cwd: s.root,
      windowsHide: true,
    });
    expect(run.status).toBe(0);
  }
  return linked;
}
test("an existing store is left as it was, and a linked worktree is answered by the cloud too", () =>
  using({}, async (r) => {
    const store = join(r.s.root, ".forge", "state.sqlite");
    writeFileSync(store, "keep");
    const linked = addWorktree(r.s);
    const other = await r.open(linked);
    try {
      const context = localContext(other, { kind: "agent", id: "a1" });
      const from = r.request("issue.show", { id: "forge-1" }, { context });
      expect(await other.catalog.invoke(from)).toMatchObject({ ok: true });
    } finally {
      await other.close();
    }
    expect(await show(r)).toMatchObject({ ok: true });
    expect(readFileSync(store, "utf8")).toBe("keep");
  }));

test("an unbound project runs locally, with no cloud request and no credential written", () =>
  using({ bind: false, creds: false, sentinel: false }, async (r) => {
    for (const op of ["issue.list", "issue.ready"])
      expect(await r.assembly.catalog.invoke(r.request(op, {}))).toMatchObject({
        ok: true,
        result: { items: [], truncated: false },
      });
    const made = await r.assembly.catalog.invoke(
      r.request("issue.create", CREATE),
    );
    expect(made).toMatchObject({ ok: true });
    const { id } = (made as { result: { id: string } }).result;
    const note = r.request(
      "issue.comment",
      { id, body: "hi" },
      { requestId: "r-2" },
    );
    expect(await r.assembly.catalog.invoke(note)).toMatchObject({ ok: true });
    const read = (id: string, requestId: string) =>
      r.assembly.catalog.invoke(
        r.request("issue.comments", { id }, { requestId }),
      );
    expect(await read(id, "r-3")).toMatchObject({
      ok: true,
      result: { records: [{ value: { body: "hi" } }] },
    });
    const bare = (
      (await r.assembly.catalog.invoke(
        r.request("issue.create", CREATE, { requestId: "r-4" }),
      )) as unknown as { result: { id: string } }
    ).result.id;
    expect(await read(bare, "r-5")).toMatchObject({
      ok: true,
      result: { records: [] },
    });
    const own = holding(r);
    const call = (op: string, input: object) =>
      dispatch(r.assembly.catalog, op, input, {
        caller: "agent",
        context: own,
      });
    expect(await call("issue.claim", { id })).toMatchObject({ ok: true });
    expect(await call("issue.renew", { id })).toMatchObject({ ok: true });
    const { revision } = (
      (await call("issue.show", { id })) as unknown as {
        result: { revision: number };
      }
    ).result;
    const renamed = await call("issue.update", {
      id,
      expectRevision: revision,
      title: "Renamed",
    });
    expect(renamed).toMatchObject({ ok: true, result: { title: "Renamed" } });
    expect(exitCode(renamed)).toBe(0);
    expect(await call("issue.release", { id })).toMatchObject({
      ok: true,
      result: { id },
    });
    expect(r.net.calls).toHaveLength(0);
    expect(existsSync(join(r.s.home, ".forge"))).toBe(false);
  }));

test("an unbound project's issue.close, with a receipt and without, still runs locally with no cloud request", () =>
  using({ bind: false, creds: false, sentinel: false }, async (r) => {
    const made = await r.assembly.catalog.invoke(
      r.request("issue.create", CREATE),
    );
    const { id } = (made as { result: { id: string } }).result;
    const own = holding(r);
    const call = (op: string, input: object) =>
      dispatch(r.assembly.catalog, op, input, {
        caller: "agent",
        context: own,
      });
    expect(await call("issue.claim", { id })).toMatchObject({ ok: true });
    const status = async () =>
      (
        (await call("issue.show", { id })) as unknown as {
          result: { status: string };
        }
      ).result.status;
    expect(await status()).toBe("open");
    const receipt = await call("issue.close", { id, receipt: "proof-1" });
    expect(receipt).toMatchObject({
      ok: false,
      error: {
        code: "RECEIPT_INVALID",
        message: "Closing requires an existing verified PASS receipt",
      },
    });
    expect(exitCode(receipt)).toBe(1);
    expect(await status()).toBe("open");
    const closed = await call("issue.close", { id, withoutReceipt: "guard" });
    expect(closed).toMatchObject({ ok: true });
    expect(exitCode(closed)).toBe(0);
    expect(await status()).toBe("closed");
    expect(r.net.calls).toHaveLength(0);
  }));

test("an unbound project's issue.dep still runs locally with no cloud request", () =>
  using({ bind: false, creds: false, sentinel: false }, async (r) => {
    const own = holding(r);
    const call = (op: string, input: object) =>
      dispatch(r.assembly.catalog, op, input, {
        caller: "agent",
        context: own,
      });
    const create = async (title: string) =>
      (
        (await r.assembly.catalog.invoke(
          r.request("issue.create", { title, kind: "task" }),
        )) as { result: { id: string } }
      ).result.id;
    const id = await create("a");
    const target = await create("b");
    expect(await call("issue.claim", { id })).toMatchObject({ ok: true });
    const { revision } = (
      (await call("issue.show", { id })) as unknown as {
        result: { revision: number };
      }
    ).result;
    const done = await call("issue.dep", {
      id,
      target,
      action: "add",
      expectRevision: revision,
    });
    expect(done).toMatchObject({ ok: true, result: { dependsOn: [target] } });
    expect(exitCode(done)).toBe(0);
    expect(r.net.calls).toHaveLength(0);
  }));

test("an unbound project's issue.link still runs locally, persists the link and reads it back, with no cloud request", () =>
  using({ bind: false, creds: false, sentinel: false }, async (r) => {
    const own = holding(r);
    const call = (op: string, input: object) =>
      dispatch(r.assembly.catalog, op, input, {
        caller: "agent",
        context: own,
      });
    const { id } = (
      (await r.assembly.catalog.invoke(r.request("issue.create", CREATE))) as {
        result: { id: string };
      }
    ).result;
    expect(await call("issue.claim", { id })).toMatchObject({ ok: true });
    const done = await call("issue.link", { ...LINK, id });
    expect(done).toMatchObject({
      ok: true,
      result: {
        namespace: "forge/work",
        revision: 1,
        value: { relation: LINK.relation, url: LINK.url },
      },
    });
    expect(exitCode(done)).toBe(0);
    expect(await call("issue.links", { id })).toMatchObject({
      ok: true,
      result: {
        records: [{ value: { relation: LINK.relation, url: LINK.url } }],
      },
    });
    expect(r.net.calls).toHaveLength(0);
    expect(existsSync(join(r.s.home, ".forge"))).toBe(false);
  }));

test("a refused preflight on a bound project is thrown, never retried on the local runtime", async () => {
  const refused = new ForgeFailure({
    code: "GRANT_REQUIRED",
    message: "no",
    retry: "never",
  });
  const preflight = mock(() => {
    throw refused;
  });
  const invoke = mock();
  const run = (r: Awaited<ReturnType<typeof rig>>) =>
    selectCloud(
      {
        root: r.s.root,
        deviceRoot: r.s.deviceRoot,
        scope: () => {},
        env: { HOME: r.s.home, FORGE_DEVICE_ID: "dev-1" },
        cloud: { fetch: r.net.fetch, now: () => NOW },
      },
      { preflight, invoke } as never,
      r.request("issue.show", { id: "forge-1" }),
    );
  await using({}, async (r) => {
    await expect(run(r)).rejects.toBe(refused);
    expect([preflight.mock.calls.length, invoke.mock.calls.length]).toEqual([
      1, 0,
    ]);
    expect(r.net.calls).toHaveLength(0);
  });
  await using({ bind: false, creds: false }, async (r) => {
    expect(await run(r)).toBeUndefined();
  });
});

// forge-1249: a cloud-bound project never starts a local store by recovery.
const RECOVER = "store.reinit";
const NAMED = {
  ok: false,
  op: RECOVER,
  status: "FAIL",
  error: { code: "INPUT_INVALID", message: notServed(RECOVER), retry: "never" },
};
const human = { kind: "human", id: "h1" } as const;
const STORE = (s: fx.Sandbox) => join(s.root, ".forge", "state.sqlite");
const SEEDED = "closed fixture, not a database";
const seeded = (s: fx.Sandbox) => writeFileSync(STORE(s), SEEDED);
/** Untrusted approval content that carries the synthetic token: it must never come back. */
const ASKED = { approval: TOKEN };
const asHuman = (r: Rig, assembly = r.assembly) =>
  r.request(RECOVER, ASKED, {
    caller: "human",
    context: localContext(assembly, human),
  });

/** Every file and folder under a directory with its bytes, so a refusal that wrote anything changes it. */
function inventory(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const path = join(at, e.name);
      const name = relative(dir, path);
      if (e.isDirectory()) {
        found[`${name}/`] = "";
        walk(path);
      } else found[name] = readFileSync(path).toString("base64");
    }
  };
  walk(dir);
  return found;
}

/** A refusal that opens or creates no local state, asks no one, sends no request and writes no file. */
async function leavingNothing(o: Setup, run: (r: Rig) => Promise<void>) {
  await using(o, async (r) => {
    const before = inventory(r.s.dir);
    const spies = [
      spyOn(LocalState.prototype, "open"),
      spyOn(LocalState.prototype, "validateCreate"),
      spyOn(LocalState.prototype, "create"),
    ];
    try {
      await run(r);
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.net.calls).toHaveLength(0);
    expect(inventory(r.s.dir)).toEqual(before);
  });
}
const refused = (result: ResultEnvelope, name?: string) => {
  expect(result, name).toMatchObject(NAMED);
  expect(failed(result, "INPUT_INVALID")).toBe(6);
};

const STORES = [
  ["missing", {}],
  ["existing", { prepare: seeded }],
] as const;
for (const [store, setup] of STORES)
  for (const dryRun of [false, true]) {
    const how = `with ${store} store${dryRun ? ", as a dry run" : ""}`;
    test(`a bound project's store reinit through the CLI, dispatch and catalog.call is refused by name ${how}, before identity resolution or any invoke`, () =>
      leavingNothing(setup, async (r) => {
        const invoke = spyOn(r.assembly.catalog, "invoke");
        const resolveContext = mock(
          localIdentityResolver(
            r.s.deviceRoot,
            { HOME: r.s.home, FORGE_DEVICE_ID: "dev-1" },
            false,
          ),
        );
        const options = {
          caller: "human" as const,
          context: localContext(r.assembly, human),
          resolveContext,
          ...(dryRun ? { dryRun } : {}),
        };
        const calls: [string, () => Promise<ResultEnvelope>][] = [
          [
            "CLI",
            async () => {
              const done = await runCli(
                r.assembly.catalog,
                [
                  "store",
                  "reinit",
                  ...(dryRun ? ["--dry-run"] : []),
                  "--input",
                  JSON.stringify(ASKED),
                ],
                options,
              );
              expect(JSON.stringify(done)).not.toContain(TOKEN);
              return done.envelope;
            },
          ],
          [
            "dispatch",
            () => dispatch(r.assembly.catalog, RECOVER, ASKED, options),
          ],
          [
            "catalog.call",
            () =>
              dispatch(
                r.assembly.catalog,
                "catalog.call",
                { op: RECOVER, input: ASKED },
                options,
              ),
          ],
        ];
        try {
          for (const [name, call] of calls) refused(await call(), name);
          expect(resolveContext).not.toHaveBeenCalled();
          expect(invoke).not.toHaveBeenCalled();
        } finally {
          invoke.mockRestore();
        }
      }));

    test(`a direct catalog.invoke of a bound project's store reinit is refused by name ${how}, without dispatch`, () =>
      leavingNothing(setup, async (r) => {
        const request = asHuman(r);
        refused(
          await r.assembly.catalog.invoke(
            dryRun ? { ...request, dryRun } : request,
          ),
        );
      }));
  }

test("a direct invoke of store reinit by an agent is still ADMISSION_REQUIRED, with nothing opened or asked", () =>
  leavingNothing({}, async (r) => {
    for (const dryRun of [false, true]) {
      const result = await r.assembly.catalog.invoke(
        r.request(RECOVER, ASKED, dryRun ? { dryRun } : {}),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { message: `Only a human may invoke ${RECOVER}` },
      });
      expect(failed(result, "ADMISSION_REQUIRED")).toBe(2);
    }
  }));

test("through MCP, store reinit stays human-only: catalog_call does not know it, as a dry run too, and no direct tool exists", () =>
  leavingNothing({}, async (r) => {
    const handlers = createMcpHandlers(
      r.assembly.catalog,
      { expose: ["issue"] },
      { context: localContext(r.assembly, { kind: "agent", id: "a1" }) },
    );
    for (const dryRun of [false, true]) {
      const result = await handlers.callTool("catalog_call", {
        op: RECOVER,
        input: ASKED,
        ...(dryRun ? { dryRun } : {}),
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "UNKNOWN_COMMAND" },
      });
      expect(failed(result!, "UNKNOWN_COMMAND")).toBe(3);
    }
    expect(await handlers.callTool(mcpToolName(RECOVER)!, ASKED)).toBe(
      undefined,
    );
  }));

test("a bound project with no saved login, no device identity and a dead network gets the same named refusal", () =>
  leavingNothing(
    {
      creds: false,
      device: false,
      steps: [
        () => {
          throw new Error("offline");
        },
      ],
    },
    async (r) => refused(await r.assembly.catalog.invoke(asHuman(r))),
  ));

for (const [name, setup, code] of rows)
  test(`store reinit with ${name} keeps that binding refusal and starts no local store`, () =>
    leavingNothing(setup, async (r) => {
      const result = await r.assembly.catalog.invoke(asHuman(r));
      failed(result, code);
      expect(result).not.toMatchObject(NAMED);
    }));

test("a bound project's store reinit from a nested folder and from a linked worktree gets the same named refusal", () => {
  let linked = "";
  return leavingNothing(
    {
      prepare: (s) => {
        linked = addWorktree(s);
        mkdirSync(join(s.root, "nested"));
      },
    },
    async (r) => {
      for (const root of [join(r.s.root, "nested"), linked]) {
        const assembly = await r.open(root);
        try {
          refused(await assembly.catalog.invoke(asHuman(r, assembly)), root);
        } finally {
          await assembly.close();
        }
      }
    },
  );
});

test("an unbound project keeps recovery as it was: an existing store conflicts and a dry run has no contract, both leaving every record and file alone", () =>
  using({ bind: false, creds: false, sentinel: false }, async (r) => {
    expect(
      await r.assembly.catalog.invoke(r.request("issue.create", CREATE)),
    ).toMatchObject({ ok: true });
    const before = inventory(r.s.dir);
    const options = {
      caller: "human" as const,
      context: localContext(r.assembly, human),
    };
    const kept = await runCli(r.assembly.catalog, ["store", "reinit"], options);
    expect(kept.exitCode).toBe(4);
    expect(kept.envelope).toMatchObject({
      ok: false,
      error: { code: "INPUT_CONFLICT" },
    });
    expect(JSON.stringify(kept.envelope)).toContain(
      "Forge store already exists",
    );
    const dry = await runCli(
      r.assembly.catalog,
      ["store", "reinit", "--dry-run"],
      options,
    );
    expect(dry.exitCode).toBe(1);
    expect(dry.envelope).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "This operation has no dry-run contract",
      },
    });
    expect(inventory(r.s.dir)).toEqual(before);
    expect(r.net.calls).toHaveLength(0);
    expect(r.confirm).not.toHaveBeenCalled();
    expect(
      await r.assembly.catalog.invoke(r.request("issue.list", {})),
    ).toMatchObject({ ok: true, result: { items: [{ title: CREATE.title }] } });
  }));

/** Runs a human reinit through dispatch and a direct invoke, each past the faulted guard, and shows both reach recovery. */
const reachesRecovery = async (r: Rig) => {
  const validate = spyOn(LocalState.prototype, "validateCreate");
  try {
    const options = {
      caller: "human" as const,
      context: localContext(r.assembly, human),
    };
    for (const run of [
      () => dispatch(r.assembly.catalog, RECOVER, ASKED, options),
      () => r.assembly.catalog.invoke(asHuman(r)),
    ]) {
      validate.mockClear();
      const result = await run();
      expect(result).not.toMatchObject(NAMED);
      expect(validate).toHaveBeenCalled();
    }
  } finally {
    validate.mockRestore();
  }
};

test("fault injection: with the core entry's block and operation removed, neither guard fires and store reinit reaches recovery validation", () =>
  using({}, async (r) => {
    const entry = discoveryOperations.find((e) => e.op === RECOVER)!;
    const saved = { blockId: entry.blockId, declaredOp: entry.declaredOp };
    Reflect.deleteProperty(entry, "blockId");
    Reflect.deleteProperty(entry, "declaredOp");
    try {
      await reachesRecovery(r);
    } finally {
      Object.assign(entry, saved);
    }
  }));

test("fault injection: with the direct admission disabled, a direct invoke reaches recovery, while dispatch with the real admission still refuses by name with nothing opened", () =>
  using({}, async (r) => {
    const catalog = r.assembly.catalog;
    const real = catalog.admit!.bind(catalog);
    const off = spyOn(catalog, "admit").mockImplementation(() => {});
    const validate = spyOn(LocalState.prototype, "validateCreate");
    try {
      const direct = await catalog.invoke(asHuman(r));
      expect(direct).not.toMatchObject(NAMED);
      expect(validate).toHaveBeenCalledTimes(1);
      validate.mockClear();
      const surface = Object.create(catalog, {
        admit: { value: real },
      }) as typeof catalog;
      refused(
        await dispatch(surface, RECOVER, ASKED, {
          caller: "human",
          context: localContext(r.assembly, human),
        }),
      );
      expect(validate).not.toHaveBeenCalled();
    } finally {
      validate.mockRestore();
      off.mockRestore();
    }
  }));

test("only forge/core's store.reinit joins the refused set: other blocks and other core operations stay local", () => {
  const route = cloudRoute("forge/core", RECOVER);
  expect(route).toBeInstanceOf(ForgeFailure);
  expect(route).toMatchObject({ error: NAMED.error });
  for (const [block, op] of [
    ["forge/core", "project.init"],
    ["forge/core", "config.show"],
    ["forge/memory", "memory.add"],
    ["forge/check", "check.run"],
  ] as const)
    expect(cloudRoute(block, op)).toBe("local");
});

test("the generated core discovery names forge/core and store.reinit, so dispatch admits it before identity resolution", () => {
  expect(discoveryOperations.find((e) => e.op === RECOVER)).toMatchObject({
    blockId: "forge/core",
    declaredOp: RECOVER,
  });
});

test("another core operation reads no binding: project.init on a project with a malformed binding is the manifest refusal", () =>
  leavingNothing({ bind: "{" }, async (r) => {
    const result = await dispatch(
      r.assembly.catalog,
      "project.init",
      {},
      { caller: "human", context: localContext(r.assembly, human) },
    );
    expect(failed(result, "PROJECT_MANIFEST_EXISTS")).toBe(1);
  }));
