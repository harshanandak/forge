import {
  afterAll,
  beforeAll,
  expect,
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockCapture } from "../../src/assembly/capture.ts";
import { cloudRoute } from "../../src/assembly/cloud-authority.ts";
import {
  credentialStore,
  openCloudFiles,
  type CloudBinding,
  type CredentialEntry,
} from "../../src/assembly/cloud-profile.ts";
import { firstPartyBlocks } from "../../src/assembly/first-party.ts";
import { createAssembly } from "../../src/assembly/index.ts";
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
const answer = (result: object = ISSUE) =>
  fx.json({ ok: true, op: "issue.show", status: "OK", result, warnings: [] });
const refusing = (code: string) =>
  fx.json(
    {
      ok: false,
      status: "FAIL",
      error: { code, message: TOKEN },
      warnings: [],
    },
    401,
  );
const MANIFEST = resolve(
  import.meta.dirname,
  "../../src/blocks/work/forge.block.json",
);
const DECLARED = Object.keys(
  (JSON.parse(readFileSync(MANIFEST, "utf8")) as { operations: object })
    .operations,
).filter((op) => op !== "issue.show");
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
    context: {
      actor: { kind: "agent", id: "a1" },
      project: { id: s.root, root: s.root },
    },
    ...change,
  });
  return { s, net, sentinel, open, request, assembly: await open() };
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

test("the routing decision refuses every other operation of the work block by name, and leaves other blocks local", () => {
  expect(DECLARED.length).toBeGreaterThan(30);
  expect(cloudRoute("forge/work", "issue.show")).toBe("cloud");
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
for (const [source, op, input, declared] of [
  [WORK, "issue.create", { title: "x" }, "issue.create"],
  [WORK, "issue.list", {}, "issue.list"],
  [RENAMED, "ticket.create", { title: "x" }, "issue.create"],
  [RENAMED, "ticket.show", { id: "forge-1" }, undefined],
] as const)
  test(`through the assembled catalog, ${op} on a bound project is ${declared ?? "answered by the cloud"}`, () =>
    using({ config: source }, async (r) => {
      const result = await r.assembly.catalog.invoke(r.request(op, input));
      if (declared === undefined)
        return void expect(result).toMatchObject({ ok: true, result: ISSUE });
      expect(failed(result, "INPUT_INVALID")).toBe(6);
      expect(result).toMatchObject({ error: { message: notServed(declared) } });
      expect(r.net.calls).toHaveLength(0);
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
        "issue.release",
        { id: "forge-1" },
        { caller: "agent", context, dryRun },
      );
      failed(held, dryRun ? "UNAVAILABLE" : "INPUT_INVALID");
    }
    const ops = r.net.calls.map((c) => (c.body as { op: string }).op);
    expect(ops).toEqual(["issue.show", "issue.show"]);
  }));

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

for (const [name, bind, creds, code] of [
  ["malformed", "{", {}, "INPUT_INVALID"],
  [
    "for another identity",
    { identity: fx.OTHER_PROJECT_ID },
    {},
    "INPUT_CONFLICT",
  ],
  ["missing while a credential is remembered", false, {}, "INPUT_CONFLICT"],
] as const)
  test(`a binding that is ${name} is refused before any local state or request`, () =>
    using({ bind, creds }, async (r) => {
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
      const context = {
        actor: { kind: "agent" as const, id: "a1" },
        project: { id: linked, root: linked },
      };
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
    const list = r.request("issue.list", {});
    expect(await r.assembly.catalog.invoke(list)).toMatchObject({ ok: true });
    expect(r.net.calls).toHaveLength(0);
    expect(existsSync(join(r.s.home, ".forge"))).toBe(false);
  }));
