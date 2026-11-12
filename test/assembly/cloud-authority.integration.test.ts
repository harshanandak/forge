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
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import { LocalState } from "../../src/assembly/state.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import type { InvocationRequest } from "../../src/generated/types.ts";
import { dispatch } from "../../src/surface/dispatch.ts";
import { exitCode } from "../../src/surface/result.ts";
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
/** The status the cloud's command route gives each refusal (cloud/src/project.ts STATUS). */
const HTTP: Record<string, number> = {
  NOT_FOUND: 404,
  INPUT_CONFLICT: 409,
  INPUT_INVALID: 400,
  INTERNAL: 500,
  REVISION_CONFLICT: 409,
  LEASE_HELD: 409,
  CLAIM_BLOCKED: 409,
  LEASE_NOT_HELD: 409,
  LEASE_STALE: 409,
  LEASE_EXPIRED: 409,
  AUTH_DEVICE_MISMATCH: 403,
};
const refusing = (code: string) =>
  fx.json(
    {
      ok: false,
      status: "FAIL",
      error: { code, message: TOKEN },
      warnings: [],
    },
    HTTP[code] ?? 401,
  );
const MANIFEST = resolve(
  import.meta.dirname,
  "../../src/blocks/work/forge.block.json",
);
const READS = ["issue.show", "issue.list", "issue.ready"];
const WRITES = [
  "issue.create",
  "issue.comment",
  "issue.update",
  "issue.claim",
  "issue.renew",
  "issue.release",
];
const SERVED = [...READS, ...WRITES];
const DECLARED = Object.keys(
  (JSON.parse(readFileSync(MANIFEST, "utf8")) as { operations: object })
    .operations,
).filter((op) => !SERVED.includes(op));
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
  const open = (root = s.root) =>
    createAssembly({
      root,
      deviceRoot: s.deviceRoot,
      providers: { env, cloudLogin: { fetch: net.fetch, now: () => NOW } },
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
  return { s, net, sentinel, open, request, assembly };
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

test("the routing decision serves show, list, ready, create, comment, update, claim, renew and release, refuses every other operation of the work block by name, and leaves other blocks local", () => {
  expect(DECLARED.length).toBeGreaterThan(30);
  for (const op of SERVED) expect(cloudRoute("forge/work", op)).toBe("cloud");
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
const HELD = { ...LEASE, generation: 3 };
const INPUTS: Record<string, object> = {
  "issue.create": CREATE,
  "issue.comment": COMMENT,
  "issue.update": UPDATE,
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
] as const)
  test(`through the assembled catalog, ${op} on a bound project is answered by the cloud as ${declared}`, () =>
    using(
      { config: source, steps: [() => answer(result, declared)] },
      async (r) => {
        const done = await r.assembly.catalog.invoke(r.request(op, input));
        expect(done).toMatchObject({ ok: true, result });
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
    for (const [op, input] of [
      ["issue.board", {}],
      ["issue.close", { id: "forge-1" }],
    ] as const) {
      const result = await r.assembly.catalog.invoke(
        r.request(op, input, { context }),
      );
      expect(failed(result, "INPUT_INVALID")).toBe(6);
      expect(result).toMatchObject({ error: { message: notServed(op) } });
    }
    expect(r.net.calls).toHaveLength(0);
  }));

for (const [op, input, bad] of [
  ["issue.create", CREATE, { ...ISSUE, revision: TOKEN }],
  ["issue.comment", COMMENT, { ...COMMENTED, extra: TOKEN }],
  ["issue.comment", COMMENT, { id: "forge-1" }],
] as const)
  test(`a cloud ${op} result that fails its declared output is refused as UNAVAILABLE`, () =>
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
  ["issue.update", UPDATE],
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

test("a held operation's hidden show goes to the cloud, and the operation itself is refused, even as a dry run", () =>
  using({ steps: [() => answer({ ...ISSUE, lease: LEASE })] }, async (r) => {
    const context = {
      ...r.request("x", {}).context,
      session: { id: "s1", device: "dev-1" },
    };
    for (const dryRun of [false, true]) {
      const held = await dispatch(
        r.assembly.catalog,
        "issue.close",
        { id: "forge-1" },
        { caller: "agent", context, dryRun },
      );
      failed(held, dryRun ? "UNAVAILABLE" : "INPUT_INVALID");
    }
    const ops = r.net.calls.map((c) => (c.body as { op: string }).op);
    expect(ops).toEqual(["issue.show", "issue.show"]);
  }));

type Rig = Awaited<ReturnType<typeof rig>>;
/** A held write as the CLI makes it: a session, the caller's own context, and a generation only if the caller names one. */
const holding = (r: Rig, own: object = {}) => ({
  ...localContext(r.assembly, { kind: "agent", id: "a1" }, "s1"),
  ...own,
});
const edit = (r: Rig, op: string, context: object, dryRun = false) =>
  dispatch(r.assembly.catalog, op, UPDATE, {
    caller: "agent",
    context,
    dryRun,
  });
const sent = (r: Rig) => r.net.calls.map((c) => (c.body as { op: string }).op);
const live = () => answer({ ...ISSUE, lease: HELD });

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

test("an existing store is left as it was, and a linked worktree is answered by the cloud too", () =>
  using({}, async (r) => {
    const store = join(r.s.root, ".forge", "state.sqlite");
    writeFileSync(store, "keep");
    const linked = join(r.s.dir, "linked");
    for (const args of [
      ["init", "--quiet"],
      ["add", "-A"],
      ["commit", "--quiet", "-m", "p"],
      ["worktree", "add", "--quiet", linked],
    ]) {
      const git = ["-c", "user.name=t", "-c", "user.email=t@example.test"];
      const run = spawnSync("git", [...git, ...args], {
        cwd: r.s.root,
        windowsHide: true,
      });
      expect(run.status).toBe(0);
    }
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
