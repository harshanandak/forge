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
import { gitExecutable } from "../../tools/git-executable.ts";
import { inlineWorkPrimitives } from "../../tools/bundle-work-primitives.ts";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { blockCapture } from "../../src/assembly/capture.ts";
import { createAssemblyProviders } from "../../src/assembly/providers.ts";
import { attachBoundLane } from "../../src/blocks/work/bound-lane.ts";
import * as boundLane from "../../src/blocks/work/bound-lane.ts";
import { boundDispatch } from "../../tools/lane-control.ts";
import { coordinateLane } from "../../src/assembly/cloud-lane-coordinator.ts";
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
import { escapeDisplayText } from "../../src/contract/display-text.ts";
import { mcpToolName } from "../../src/contract/naming.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { Runtime } from "../../src/core/runtime/index.ts";
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
import { done, stageBlock } from "../blocks/memory/lib.ts";
import * as fx from "./cloud-fixture.ts";
import * as scopedGit from "../../src/assembly/providers.ts";
import * as launch from "../../src/adapters/process/run.ts";
import * as startupScope from "../../src/assembly/git-scope.ts";
import { validGitScope } from "../../src/assembly/saved-git-scope.ts";
import { cloudBinding } from "../../src/assembly/cloud-binding.ts";

for (const [name, row, guard, replacement, marker] of [
  [
    "Remove-project-exclusion",
    "plain checkout",
    "excluded.some((base) => within(base, candidate))",
    "false",
    "projectRan",
  ],
  [
    "Real-only-candidate-check",
    "project alias",
    "[found.path, canonical]",
    "[canonical]",
    "externalRan",
  ],
  [
    "Reuse-pin-across-projects",
    "cross-project",
    "...roots(target)",
    "...roots(scope)",
    "externalRan",
  ],
  [
    "Allow-relative-PATH",
    "relative and empty",
    "!fullyAbsolute(directory)",
    "false",
    "relativeRan",
  ],
  [
    "Empty-result-fallback",
    "only unsafe",
    'if (pin.kind !== "resolved") return pin;',
    'if (pin.kind !== "resolved") return executor.resolve("git", { ...env, PATH: scope.project.lexical });',
    "projectRan",
  ],
  [
    "Ban-all-repositories",
    "unrelated repository",
    "excluded.some((base) => within(base, candidate))",
    'excluded.some((base) => within(base, candidate)) || (() => { for (let at = dirname(candidate); ; at = dirname(at)) { if (readdirSync(at).includes(".git")) return true; if (dirname(at) === at) return false; } })()',
    "externalRan",
  ],
  [
    "Canonical-only-pin-reuse",
    "cross-project alias",
    "resolveOutside(executor, lexical, env",
    "resolveOutside(executor, pin.path, env",
    "externalRan",
  ],
] as const)
  test(`git resolver rejects repository executables despite scope mutation: ${name}`, async () => {
    expect(typeof (scopedGit as unknown as fx.ScopedGitApi).gitCapability).toBe(
      "function",
    );
    const mutant = await fx.withoutGuard<fx.ScopedGitApi>(
      new URL("../../src/assembly/providers.ts", import.meta.url),
      guard,
      replacement,
    );
    expect(mutant.mutationLoaded).toBe(true);
    const selectionOnly = name === "Allow-relative-PATH";
    if (selectionOnly)
      expect(await fx.exerciseGitScope(row, scopedGit, true)).toMatchObject({
        relativeRan: false,
        externalRan: false,
      });
    const result = await fx.exerciseGitScope(row, mutant, selectionOnly);
    expect(result[marker]).toBe(false);
    expect(result.kind).toBe("unavailable");
  }, 30000);
import * as durable from "../../src/adapters/fs/durable-io.ts";
import * as authority from "../../src/assembly/cloud-binding.ts";
import { relay } from "../fixtures/owner-approval.ts";
import {
  boundLaneKey,
  readBoundLane,
  writeBoundLane,
} from "../../src/blocks/work/bound-lane-state.ts";
import {
  approvalReply,
  writeOwnerPolicy,
} from "../fixtures/owner-approval.mjs";

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
const LINK_RECORD = {
  ...RECORD,
  key: "link:work-1:1",
  value: { id: "work-1", relation: "delivers", url: "https://example.com/p/1" },
};
const LINK_RECORDS = { records: [LINK_RECORD] };
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
const READS = [
  "issue.show",
  "issue.list",
  "issue.ready",
  "issue.blocked",
  "issue.stale",
  "issue.comments",
  "issue.links",
];
const LISTS = ["issue.list", "issue.ready", "issue.blocked", "issue.stale"];
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
const SERVED = [
  ...READS,
  ...WRITES,
  "lane.stop",
  "lane.control",
  "lane.resume",
  "lane.dispatch",
];
/** Every operation the work block declares, read from its manifest. */
const MANIFEST_OPS = Object.keys(
  (JSON.parse(readFileSync(MANIFEST, "utf8")) as { operations: object })
    .operations,
);
const COORDINATED = [
  "start",
  "show",
  "status",
  "next",
  "record",
  "close",
  "release",
].map((verb) => `lane.${verb}`);
const DECLARED = MANIFEST_OPS.filter(
  (op) => !SERVED.includes(op) && !COORDINATED.includes(op),
);
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
const PROBE_MUTATIONS =
  "put put-many put-next delete acquire renew release".split(" ");
beforeAll(async () => {
  staging = mkdtempSync(join(tmpdir(), "forge-authority-blocks-"));
  const [memory, work, cloud] = [
    "forge/memory",
    "forge/work",
    "forge/cloud",
  ].map((id) => fileURLToPath(firstPartyBlocks[id]!));
  const workEntry = await inlineWorkPrimitives(
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      readFileSync(join(work!, "entry.cts"), "utf8"),
    ),
    join(work!, "record-primitives.ts"),
  );
  const compiled = (source: string, name: string) => {
    const target = join(staging, name);
    cpSync(source, target, {
      recursive: true,
      filter: (path) => !path.endsWith(".cts"),
    });
    const entry = new Bun.Transpiler({ loader: "ts" }).transformSync(
      readFileSync(join(source, "entry.cts"), "utf8"),
    );
    writeFileSync(
      join(target, "entry.cjs"),
      name === "work" ? workEntry : entry,
    );
    return target;
  };
  const check = fileURLToPath(firstPartyBlocks["forge/check"]!);
  const stages = new Map([
    [memory!, stageBlock("memory", staging)],
    [work!, compiled(work!, "work")],
    [cloud!, compiled(cloud!, "cloud")],
    [check, compiled(check, "check")],
  ]);
  const open = blockCapture.open.bind(blockCapture);
  capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    open(stages.get(path) ?? path),
  );
  const probe = join(staging, "probe");
  cpSync(resolve(import.meta.dirname, "../../examples/hello-block"), probe, {
    recursive: true,
  });
  const verbs = [...PROBE_MUTATIONS, "device", "escalate", "read", "sneak"];
  const manifest = JSON.parse(
    readFileSync(join(probe, "forge.block.json"), "utf8"),
  ) as Record<string, unknown>;
  manifest.id = "test/probe";
  manifest.requires = ["state", "levels"].map((slot) => ({
    slot,
    interface: slot === "state" ? "forge.state@1" : "forge.project-state@1",
  }));
  manifest.operations = Object.fromEntries(
    verbs.map((verb) => {
      const leased = ["acquire", "renew", "release"].includes(verb);
      return [
        `probe.${verb}`,
        {
          ...(manifest.operations as Record<string, object>)["hello.say"],
          context: leased
            ? "leased"
            : ["device", "escalate"].includes(verb)
              ? "device"
              : "project",
          ...(leased
            ? { leaseMode: verb === "acquire" ? "acquire" : "held" }
            : {}),
          cli: `alias.${verb}`,
          effects: ["read", "sneak"].includes(verb) ? [] : ["probe:write"],
          idempotent: false,
          timeoutMs: 5000,
        },
      ];
    }),
  );
  writeFileSync(join(probe, "forge.block.json"), JSON.stringify(manifest));
  for (const name of ["input.schema.json", "output.schema.json"])
    writeFileSync(join(probe, name), "{}");
  writeFileSync(
    join(probe, "docs.json"),
    JSON.stringify({
      operations: Object.fromEntries(
        verbs.map((verb) => [`probe.${verb}`, { title: verb, summary: verb }]),
      ),
    }),
  );
  writeFileSync(
    join(probe, "index.cjs"),
    `module.exports=Object.fromEntries(${JSON.stringify(verbs)}.map(verb=>["probe."+verb,async({services,input})=>{
    const s=verb==="escalate"?(await services.levels.project()).state:services.state;
    if(verb==="read")return s.list();
    if(verb==="put-many")return s.putMany([{key:"batch",value:1,expectRevision:0}]);
    if(verb==="put-next")return s.putNext("number/",()=>({value:1}));
    if(verb==="delete")return s.delete("record",{expectRevision:1});
    if(verb==="acquire")return s.acquire("probe:record",60000);
    if(verb==="renew")return s.renew("probe:record",60000);
    if(verb==="release")return s.release("probe:record");
    return s.put("record",1,{expectRevision:input.revision||0});
  }]));`,
  );
});
afterAll(() => {
  capture.mockRestore();
  rmSync(staging, { recursive: true, force: true });
});

interface Setup {
  head?: () => string;
  bind?: Partial<CloudBinding> | string | false;
  creds?: Partial<CredentialEntry> | false;
  device?: string | false;
  steps?: fx.Step[];
  config?: string;
  now?: () => number;
  attended?: () => boolean;
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
    expect(r.sentinel?.mock.calls.filter(([write]) => write) ?? []).toEqual([]);
  } finally {
    await r.assembly.close();
    r.headRead?.mockRestore();
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
    PATH: process.env.PATH ?? "",
    PATHEXT: process.env.PATHEXT ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    WINDIR: process.env.WINDIR ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    FORGE_NO_BROWSER: "1",
    HOME: s.home,
    ...(o.device === false ? {} : { FORGE_DEVICE_ID: o.device ?? "dev-1" }),
  };
  /** A person at a terminal who is asked and declines, so an approval request is counted and nothing is approved. */
  const confirm = mock(() => Promise.resolve(false));
  const terminal = {
    tty: () => ({ stdin: o.attended?.() ?? true, stderr: true }),
    confirm,
  };
  const open = (root = s.root) =>
    createAssembly({
      root,
      deviceRoot: s.deviceRoot,
      providers: {
        env,
        cloudLogin: { fetch: net.fetch, now: o.now ?? (() => NOW) },
      },
      terminal,
    });
  const nativeRun = launch.runProcess;
  const headRead = o.head
    ? spyOn(launch, "runProcess").mockImplementation((...args) =>
        args[1].join(" ") === "rev-parse --verify HEAD"
          ? Promise.resolve({
              exitCode: 0,
              signal: null,
              stdout: o.head!(),
              stderr: "",
              timedOut: false,
              truncated: false,
              durationMs: 0,
            })
          : nativeRun(...args),
      )
    : undefined;
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
  return { s, net, sentinel, open, request, assembly, confirm, env, headRead };
}
const show = (r: Awaited<ReturnType<typeof rig>>) =>
  r.assembly.catalog.invoke(r.request("issue.show", { id: "forge-1" }));
const failed = (result: Awaited<ReturnType<typeof show>>, code: string) => {
  expect(result).toMatchObject({ ok: false, error: { code } });
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  return exitCode(result);
};

const journalKey = (identity = fx.PROJECT_ID) =>
  `bound-lane:${JSON.stringify([fx.ORIGIN, identity, fx.PROJECT])}:work-1`;
const attachment = {
  issue: "work-1",
  issueId: "work-1",
  worktree: "/lane",
  branch: "feat/one",
  brief: "brief.md",
};
const journal = {
  version: 1 as const,
  id: "work-1",
  cloudId: "forge-1",
  lane: attachment,
  grant: heldBy(),
  active: true,
};
for (const change of [
  { identity: fx.OTHER_PROJECT_ID },
  { origin: fx.OTHER_ORIGIN },
  { project: "other" },
])
  test(`device journal key separates ${Object.keys(change)[0]}`, () => {
    expect(boundLaneKey(fx.bindingFor(change), "work-1")).not.toBe(
      boundLaneKey(fx.bindingFor(), "work-1"),
    );
  });
async function seedJournal(
  s: Pick<fx.Sandbox, "deviceRoot">,
  value: unknown,
  identity = fx.PROJECT_ID,
) {
  const state = new LocalState(join(s.deviceRoot, "records.sqlite"));
  try {
    (await state.open(true))!.put(
      "forge/work",
      journalKey(identity),
      value,
      { kind: "agent", id: "a1" },
      { expectRevision: 0 },
    );
  } finally {
    await state.close();
  }
}
for (const row of [
  "reopen",
  "legacy",
  "legacy with explicit input",
  "retargeted",
  "missing worktree",
  "non-string worktree",
  "Accept-legacy-record",
] as const)
  test(`private attachment saved roots: ${row}`, async () => {
    const f = fx.persistedRootsFixture();
    const deviceRoot = join(dirname(f.project), "device");
    const spies: { mockRestore(): void }[] = [];
    try {
      if (row === "Accept-legacy-record") {
        const mutant = await fx.withoutGuard<typeof startupScope>(
          new URL("../../src/assembly/git-scope.ts", import.meta.url),
          /\.lane\.gitScope \?\?\s+null/,
          ".lane.gitScope ?? reopenGitScope(root)",
        );
        expect(mutant.mutationLoaded).toBe(true);
        spies.push(
          spyOn(startupScope, "deviceGitScope").mockImplementation(
            mutant.deviceGitScope,
          ),
        );
      }
      for (const root of [f.target, join(f.project, "lane")]) {
        if (root !== f.target)
          mkdirSync(join(root, ".git"), { recursive: true });
        const config = join(root, ".forge");
        mkdirSync(config, { recursive: true });
        writeFileSync(join(config, "config.yaml"), WORK);
        writeFileSync(
          join(config, "project.json"),
          JSON.stringify({ schema: 1, id: fx.PROJECT_ID }),
        );
        writeFileSync(
          join(config, "cloud.json"),
          JSON.stringify(fx.bindingFor()),
        );
      }
      const lane: Record<string, unknown> = {
        ...attachment,
        worktree: realpathSync.native(f.target),
        gitScope: f.scope,
      };
      if (row.startsWith("legacy") || row === "Accept-legacy-record")
        delete lane.gitScope;
      if (row === "missing worktree") delete lane.worktree;
      if (row === "non-string worktree") lane.worktree = 7;
      await seedJournal({ deviceRoot }, { ...journal, lane });
      if (row === "retargeted") {
        rmSync(f.alias, { recursive: true });
        fx.directoryLink(f.project, f.alias);
      }
      const before = [
        readFileSync(join(deviceRoot, "records.sqlite")).toString("hex"),
        ...f.snapshot(),
      ];
      expect(cloudBinding(f.lexical, undefined)).toMatchObject({
        kind: "bound",
        identity: fx.PROJECT_ID,
      });
      const gitScope = await startupScope.deviceGitScope(
        f.lexical,
        deviceRoot,
        undefined,
        row === "legacy with explicit input" ? f.scope : undefined,
      );
      const launch = fx.launchSavedGit(f, gitScope, scopedGit, f.lexical);
      if (row === "reopen") expect((await launch).exitCode).toBe(0);
      else if (row === "Accept-legacy-record")
        expect((await launch).exitCode).toBe(0);
      else
        await expect(launch).rejects.toMatchObject({
          error: { code: "INPUT_CONFLICT" },
        });
      expect(existsSync(f.marker)).toBe(false);
      expect([
        readFileSync(join(deviceRoot, "records.sqlite")).toString("hex"),
        ...f.snapshot(),
      ]).toEqual(before);
    } finally {
      for (const spy of spies) spy.mockRestore();
      f.close();
    }
  });
test("private scope lookup does not open a missing private state file", () =>
  using({}, async (r) => {
    const open = spyOn(LocalState.prototype, "open");
    try {
      const scope = await startupScope.deviceGitScope(
        r.s.root,
        r.s.deviceRoot,
        r.s.home,
      );
      expect(scope).toEqual(scopedGit.createGitScope(r.s.root));
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  }));
const bytes = (s: fx.Sandbox) =>
  readdirSync(s.dir, { recursive: true, withFileTypes: true })
    .map((entry) => ({
      path: join(entry.parentPath, entry.name),
      file: entry.isFile(),
    }))
    .map(({ path, file }) => [
      relative(s.dir, path),
      file ? readFileSync(path).toString("hex") : null,
    ]);
for (const [name, value, identity, id, code] of [
  ["missing journal", undefined, fx.PROJECT_ID, "forge-1", "NOT_FOUND"],
  ["current journal", journal, fx.PROJECT_ID, "forge-1", "OK"],
  [
    "malformed pending release id",
    { ...journal, releaseNeeded: true, releaseRequestId: "invalid id" },
    fx.PROJECT_ID,
    "forge-1",
    "INPUT_CONFLICT",
  ],
  ["local prefix differs from cloud", journal, fx.PROJECT_ID, "forge-1", "OK"],
  [
    "missing stored cloud id",
    Object.fromEntries(
      Object.entries(journal).filter(([key]) => key !== "cloudId"),
    ),
    fx.PROJECT_ID,
    "forge-1",
    "INPUT_CONFLICT",
  ],
  [
    "wrong stored cloud id",
    { ...journal, cloudId: "forge-2" },
    fx.PROJECT_ID,
    "forge-1",
    "INPUT_CONFLICT",
  ],
  ...(
    [
      [
        "different actor kind",
        { actor: { ...CLOUD_HOLDER.actor, kind: "human" } },
      ],
      ["different actor id", { actor: { ...CLOUD_HOLDER.actor, id: "other" } }],
      [
        "different session",
        { session: { ...CLOUD_HOLDER.session, id: "other" } },
      ],
      [
        "different device",
        { session: { ...CLOUD_HOLDER.session, device: "other" } },
      ],
    ] as const
  ).map(
    ([name, holder]) =>
      [
        name,
        {
          ...journal,
          grant: { ...heldBy(), holder: { ...CLOUD_HOLDER, ...holder } },
        },
        fx.PROJECT_ID,
        "forge-1",
        "OK",
      ] as const,
  ),
  [
    "project exceeds issue scan budgets",
    journal,
    fx.PROJECT_ID,
    "forge-1",
    "OK",
  ],
  [
    "replaced grant",
    { ...journal, grant: { ...heldBy(), generation: 3 } },
    fx.PROJECT_ID,
    "forge-1",
    "OK",
  ],
  ["changed display prefix", journal, fx.PROJECT_ID, "renamed-1", "OK"],
  ["other project", journal, fx.OTHER_PROJECT_ID, "forge-1", "NOT_FOUND"],
  [
    "malformed record",
    { ...journal, grant: null },
    fx.PROJECT_ID,
    "forge-1",
    "INPUT_CONFLICT",
  ],
  [
    "wrong canonical identity",
    { ...journal, id: "work-2" },
    fx.PROJECT_ID,
    "forge-1",
    "INPUT_CONFLICT",
  ],
  [
    "inactive journal",
    { ...journal, active: false },
    fx.PROJECT_ID,
    "forge-1",
    "OK",
  ],
] as const) {
  for (const op of ["lane.show", "lane.status"])
    test(`bound ${op}: ${name} is diagnostic and changes no bytes`, () =>
      using(
        {
          config: yaml({
            config: {
              idPrefix:
                name === "local prefix differs from cloud"
                  ? "my-repo"
                  : id.replace(/-\d+$/, ""),
            },
          }),
          prepare: (s) =>
            value === undefined ? undefined : seedJournal(s, value, identity),
          steps: [
            ({ body }) => {
              const call = body as { op: string; input: object };
              if (call.op === "issue.list") {
                throw new Error(
                  "Project exceeds 10,000 issues or 8 MiB scan budget",
                );
              }
              expect(call.op).toBe("issue.show");
              expect([id, journal.cloudId]).toContain(
                (call.input as { id: string }).id,
              );
              return answer({ ...ISSUE, id, lease: heldBy() });
            },
          ],
        },
        async (r) => {
          const before = bytes(r.s);
          const invoke = () =>
            r.assembly.catalog.invoke(
              r.request(op, op === "lane.show" ? { id } : {}),
            );
          for (let restart = 0; restart < 2; restart++) {
            const result = await invoke();
            const expected =
              op === "lane.status" && code === "NOT_FOUND" ? "OK" : code;
            expect(result.ok ? "OK" : result.error.code).toBe(expected);
            expect(exitCode(result)).toBe(
              expected === "OK" ? 0 : expected === "NOT_FOUND" ? 3 : 4,
            );
            if (code === "OK") {
              if (op === "lane.show")
                expect(result).toMatchObject({
                  result: { ...attachment, issue: id, lease: heldBy() },
                });
              else
                expect(result).toMatchObject({
                  result: {
                    enabled: false,
                    lanes: [
                      {
                        id,
                        step:
                          value?.active === false
                            ? "inactive"
                            : name === "replaced grant" ||
                                name.startsWith("different")
                              ? "stale"
                              : "attached",
                      },
                    ],
                  },
                });
            }
            if (restart === 0) {
              await r.assembly.close();
              r.assembly = await r.open();
            }
          }
          expect(bytes(r.s)).toEqual(before);
          if (code === "OK")
            expect(
              r.net.calls.some(
                (call) =>
                  (call.body as { input: { id: string } }).input.id ===
                  journal.cloudId,
              ),
            ).toBe(true);
          expect(
            r.net.calls.every(
              (call) => (call.body as { op: string }).op === "issue.show",
            ),
          ).toBe(true);
        },
      ));
}
for (const [op, input] of [
  ["lane.next", { all: true }],
  [
    "lane.record",
    { reply: "A", source: { harness: "x", thread: "y", message: "z" } },
  ],
  ["lane.release", { id: "forge-1", attempt: "attempt-1" }],
  ["lane.close", { id: "forge-1", noPr: true, dropped: "stopped" }],
  ["lane.show", { id: "forge-1", attempt: "attempt-1" }],
] as const)
  test(`bound ${op} refuses unsupported variants before effects`, () =>
    using({ device: false, creds: false }, async (r) => {
      const before = bytes(r.s);
      const result = await r.assembly.catalog.invoke(
        r.request(op, input, {
          context: { ...holding(r), leaseGeneration: 4 },
        }),
      );
      expect(failed(result, "INPUT_INVALID")).toBe(6);
      expect(r.net.calls).toHaveLength(0);
      expect(bytes(r.s)).toEqual(before);
    }));
test("unbound lane show keeps its existing clone-files refusal outside Git without cloud or device initialization", () =>
  using({ bind: false, creds: false, sentinel: false }, async (r) => {
    const before = bytes(r.s);
    const result = await r.assembly.catalog.invoke(
      r.request("lane.show", { id: "forge-1" }),
    );
    expect(failed(result, "UNAVAILABLE")).toBe(1);
    expect(r.net.calls).toHaveLength(0);
    expect(bytes(r.s)).toEqual(before);
  }));
test("another clone of the same bound project reads the same device attachment", () =>
  using(
    {
      prepare: (s) => seedJournal(s, journal),
      steps: [() => answer({ ...ISSUE, lease: heldBy() })],
    },
    async (r) => {
      const clone = join(r.s.dir, "clone");
      cpSync(r.s.root, clone, { recursive: true });
      const assembly = await r.open(clone);
      try {
        const before = bytes(r.s);
        const result = await assembly.catalog.invoke(
          r.request(
            "lane.show",
            { id: ISSUE.id },
            { context: localContext(assembly, { kind: "agent", id: "a1" }) },
          ),
        );
        expect(result).toMatchObject({
          ok: true,
          result: { ...attachment, issue: ISSUE.id, lease: heldBy() },
        });
        expect(bytes(r.s)).toEqual(before);
      } finally {
        await assembly.close();
      }
    },
  ));
for (const op of ["lane.show", "lane.status"])
  test(`bound ${op} never falls back after cloud timeout`, () =>
    using(
      {
        prepare: (s) => seedJournal(s, journal),
        steps: [
          () => {
            throw new Error("timeout");
          },
        ],
      },
      async (r) => {
        const before = bytes(r.s);
        const result = await r.assembly.catalog.invoke(
          r.request(op, op === "lane.show" ? { id: ISSUE.id } : {}),
        );
        expect(failed(result, "UNAVAILABLE")).toBe(1);
        expect(bytes(r.s)).toEqual(before);
      },
    ));

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

test("the routing decision serves show, list, ready, blocked, stale, comments, links, create, comment, update, dep, link, close, claim, renew and release, refuses every other operation of the work block by name, and leaves other blocks local", () => {
  // The refused set is exactly the manifest minus the served list: a served name the manifest does not declare would hide here.
  for (const op of SERVED) expect(MANIFEST_OPS).toContain(op);
  expect(DECLARED).toHaveLength(
    MANIFEST_OPS.length - SERVED.length - COORDINATED.length,
  );
  for (const op of COORDINATED)
    expect(String(cloudRoute("forge/work", op))).toBe("coordinator");
  for (const op of ["issue.blocked", "issue.stale"])
    expect(cloudRoute("forge/work", op)).toBe("cloud");
  for (const op of ["issue.board", "issue.events", "issue.tree", "issue.lint"])
    expect(DECLARED).toContain(op);
  for (const op of [
    "issue.blocked",
    "issue.stale",
    "issue.link",
    "issue.links",
  ])
    expect(DECLARED).not.toContain(op);
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
  [WORK, "issue.links", NOTES, "issue.links", LINK_RECORDS],
  [RENAMED, "ticket.links", NOTES, "issue.links", LINK_RECORDS],
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
    for (const [op, input] of [
      ["issue.board", {}],
      ["issue.events", NOTES],
      ["issue.tree", {}],
      ["issue.lint", {}],
    ] as const) {
      const result = await r.assembly.catalog.invoke(
        r.request(op, input, { context }),
      );
      expect(failed(result, "INPUT_INVALID")).toBe(6);
      expect(result).toMatchObject({ error: { message: notServed(op) } });
    }
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
  ["no records", "issue.links", NOTES, {}],
  ["records that is not a list", "issue.links", NOTES, { records: "x" }],
  [
    "an extra top-level key",
    "issue.links",
    NOTES,
    { records: [], truncated: false },
  ],
  [
    "an invalid record carrying the token",
    "issue.links",
    NOTES,
    { records: [{ ...LINK_RECORD, revision: TOKEN }] },
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
    ["issue.links", NOTES],
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
  ["issue.links", NOTES],
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
  [WORK, "issue.blocked", {}, "issue.blocked"],
  [WORK, "issue.blocked", FILTERS, "issue.blocked"],
  [WORK, "issue.stale", {}, "issue.stale"],
  [WORK, "issue.stale", FILTERS, "issue.stale"],
  [RENAMED, "ticket.blocked", FILTERS, "issue.blocked"],
  [RENAMED, "ticket.stale", {}, "issue.stale"],
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

for (const op of LISTS)
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

for (const op of LISTS)
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

for (const [source, noun] of [
  [WORK, "issue"],
  [RENAMED, "ticket"],
] as const)
  test(`through the CLI wrapper, ${noun} links reads the cloud with one request and returns its records unchanged, and --dry-run is UNAVAILABLE with none`, () =>
    using(
      { config: source, steps: [() => answer(LINK_RECORDS, "issue.links")] },
      async (r) => {
        const own = { caller: "agent", context: holding(r) } as const;
        const dry = await runCli(
          r.assembly.catalog,
          [noun, "links", "forge-1", "--dry-run"],
          own,
        );
        dryRefused(r, dry.envelope);
        expect(dry.exitCode).toBe(1);
        const done = await runCli(
          r.assembly.catalog,
          [noun, "links", "forge-1"],
          own,
        );
        expect(done.envelope).toMatchObject({
          ok: true,
          op: `${noun}.links`,
          result: LINK_RECORDS,
        });
        expect(done.exitCode).toBe(0);
        expect(r.net.calls).toHaveLength(1);
        expect(r.net.calls[0]!.body).toMatchObject({
          op: "issue.links",
          input: NOTES,
        });
      },
    ));

for (const [source, noun] of [
  [WORK, "issue"],
  [RENAMED, "ticket"],
] as const)
  for (const verb of ["blocked", "stale"] as const)
    test(`through the CLI wrapper, ${noun} ${verb} reads the cloud with one request and returns its items unchanged, and --dry-run is UNAVAILABLE with none`, () =>
      using(
        { config: source, steps: [() => answer(PAGE, `issue.${verb}`)] },
        async (r) => {
          const own = { caller: "agent", context: holding(r) } as const;
          const dry = await runCli(
            r.assembly.catalog,
            [noun, verb, "--dry-run"],
            own,
          );
          dryRefused(r, dry.envelope);
          expect(dry.exitCode).toBe(1);
          const done = await runCli(
            r.assembly.catalog,
            [noun, verb, "--input", JSON.stringify(FILTERS)],
            own,
          );
          expect(done.envelope).toMatchObject({
            ok: true,
            op: `${noun}.${verb}`,
          });
          expect((done.envelope as { result: unknown }).result).toEqual(PAGE);
          expect(done.exitCode).toBe(0);
          expect(r.net.calls).toHaveLength(1);
          expect(r.net.calls[0]!.body).toMatchObject({
            op: `issue.${verb}`,
            input: FILTERS,
          });
        },
      ));

// A schema-valid or invalid answer that carries the presented token, in a value or as a key, is the fixed UNAVAILABLE.
for (const verb of ["blocked", "stale"] as const)
  for (const [name, item] of [
    ["a title", { ...ISSUE, title: `before-${TOKEN}-after` }],
    ["a label", { ...ISSUE, labels: ["a", `before-${TOKEN}-after`] }],
    ["a property name", { ...ISSUE, [TOKEN]: "x" }],
  ] as const)
    test(`through the CLI wrapper, issue ${verb} whose answer carries the presented token in ${name} is the fixed UNAVAILABLE, with the token in neither the envelope nor stdout`, () =>
      using(
        {
          steps: [
            () => answer({ items: [item], truncated: false }, `issue.${verb}`),
          ],
        },
        async (r) => {
          const done = await runCli(r.assembly.catalog, ["issue", verb], {
            caller: "agent",
            context: holding(r),
          });
          const error = errorOf(done) as { code: string; message: string };
          expect(error.code).toBe("UNAVAILABLE");
          expect(error.message).toStartWith(
            "The Forge cloud gave no usable answer",
          );
          for (const shown of [JSON.stringify(done.envelope), done.stdout])
            expect(shown).not.toMatch(/fct_|before-/);
          expect(done.exitCode).toBe(1);
          expect(r.net.calls).toHaveLength(1);
        },
      ));

type Rig = Awaited<ReturnType<typeof rig>>;
/** A held write as the CLI makes it: a session, the caller's own context, and a generation only if the caller names one. */
const holding = (r: Rig, own: object = {}) => ({
  ...localContext(r.assembly, { kind: "agent", id: "a1" }, "s1"),
  ...own,
});
const OWN_GRANT: LeaseRecord = {
  ...heldBy(),
  holder: {
    actor: { kind: "agent", id: "a1" },
    session: { id: "s1", device: "dev-1" },
  },
};
const PREPARED_BRIEF = [
  "Goal",
  "Acceptance test",
  "Files",
  "Forbidden actions",
  "Stop point",
  "Prior art",
]
  .map(
    (section) =>
      `## ${section}\n${section === "Acceptance test" ? "| Case | Input | Status | Exit | Eligibility | Unchanged |\n| --- | --- | --- | --- | --- | --- |\n| attach | own | OK | 0 | attached | files |" : "Prepared by the agent."}`,
  )
  .join("\n\n");
const attachmentBytes = (s: fx.Sandbox) =>
  [
    join(s.deviceRoot, "records.sqlite"),
    join(s.root, ".git", "forge-lanes.json"),
  ].map((path) =>
    existsSync(path) ? readFileSync(path).toString("hex") : null,
  );
// PR 2a: reservations are device progress, never process permission.
async function initialReservationRace(
  r: Rig,
  coordinate: typeof coordinateLane,
) {
  const s = fx.sandbox();
  const device = new LocalState(join(s.deviceRoot, "records.sqlite"));
  await seedJournal(s, {
    ...journal,
    lane: {
      ...attachment,
      worktree: s.root,
      gitScope: scopedGit.createGitScope(s.root),
    },
    grant: OWN_GRANT,
  });
  await device.open(false);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const open = device.open.bind(device);
  let writes = 0;
  const delayed = spyOn(device, "open").mockImplementation(async (write) => {
    if (write && ++writes === 1) {
      entered.resolve();
      await release.promise;
    }
    return open(write);
  });
  const flight = {
    operation: {
      declaredOp: "lane.next",
      declaration: { effects: ["environment:read", "external:process"] },
    },
    config: {},
    request: r.request(
      "lane.next",
      { id: ISSUE.id, head: "a".repeat(40) },
      { context: holding(r) },
    ),
  } as unknown as Parameters<typeof coordinateLane>[0];
  const invoke = () =>
    coordinate(
      flight,
      fx.bindingFor(),
      device,
      () => Promise.resolve({ ...ISSUE, lease: OWN_GRANT }),
      {
        providers: createAssemblyProviders(s.root, { env: r.env }),
        env: r.env,
        deviceRoot: s.deviceRoot,
        now: () => NOW,
      },
    );
  try {
    const calls = [invoke(), invoke()];
    await entered.promise;
    release.resolve();
    const replies = await Promise.allSettled(calls);
    const saved = (await open(false))!.get("forge/work", journalKey())!;
    return { replies, saved, writes };
  } finally {
    release.resolve();
    delayed.mockRestore();
    await device.close();
    s.close();
  }
}
for (const [name, variants] of [
  ["Same pending next", ["repeat", "restart", "revision race", "missing head"]],
  [
    "Old verdict/result",
    [
      "verdict",
      "result",
      "generation",
      "generation counterfactual",
      "reattach result",
      "reattach verdict",
      "head replay",
      "checkout result",
      "checkout verdict",
      "checkout ask",
      "checkout answer",
    ],
  ],
  [
    "Budget reached",
    [
      "calls",
      "reviewRounds",
      "ciFixRounds",
      "activeHours",
      "disabled",
      "pending time",
      "regrant calls",
      "regrant review",
      "regrant ci",
      "regrant time",
      "regrant review ask",
      "regrant review held",
      "regrant review retry",
      "regrant ci ask",
      "regrant ci held",
    ],
  ],
  ["Owner ask", ["ask", "held answer", "completion after hold", "hostile ask"]],
  [
    "Expired or replaced grant",
    [
      "expired",
      "renewal failure",
      "generation",
      "holder",
      "inactive",
      "release pending",
    ],
  ],
  [
    "Malformed progress",
    ["counter", "permit", "pending", "verdict", "ask", "missing head"],
  ],
] as const)
  test(`bound progress table: ${name}`, async () => {
    for (const variant of variants) {
      let time = NOW;
      let lease: LeaseRecord = OWN_GRANT;
      let recordingGeneration = lease.generation;
      const head = "a".repeat(40),
        moved = "b".repeat(40);
      let checkoutHead = head;
      const progress = {
        generation: OWN_GRANT.generation,
        actions: 1,
        records: 0,
        review: 0,
        ci: 0,
        started: NOW,
        pending: true,
        head,
      };
      const malformed = {
        counter: { ...progress, actions: -1 },
        permit: { ...progress, permit: true },
        pending: { ...progress, pending: "yes" },
        "missing head": Object.fromEntries(
          Object.entries(progress).filter(([key]) => key !== "head"),
        ),
        verdict: { ...progress, verdict: { head, verdict: "PASS" } },
        ask: { ...progress, ask: { reason: "scope" } },
      };
      await using(
        {
          head: () => checkoutHead,
          now: () => time,
          config: yaml({
            config: {
              lanes: {
                autopilot: {
                  enabled: variant !== "disabled",
                  budgets: {
                    calls: ["calls", "regrant calls"].includes(variant)
                      ? 1
                      : 20,
                    reviewRounds: 1,
                    ciFixRounds: 1,
                    activeHours: 1,
                  },
                },
              },
            },
          }),
          prepare: async (s) => {
            if (
              (name === "Old verdict/result" &&
                !variant.startsWith("checkout ") &&
                !["verdict", "result", "generation", "head replay"].includes(
                  variant,
                )) ||
              variant.startsWith("regrant ")
            ) {
              expect(
                spawnSync("git", [
                  "init",
                  "--quiet",
                  "--initial-branch=feat/one",
                  s.root,
                ]).status,
              ).toBe(0);
              writeFileSync(join(s.root, "brief.md"), PREPARED_BRIEF);
              writeFileSync(
                join(s.root, "old-result.log"),
                JSON.stringify({ head, done: true }),
              );
            }
            await seedJournal(s, {
              ...journal,
              lane: {
                ...attachment,
                worktree: realpathSync.native(s.root),
                gitScope: scopedGit.createGitScope(s.root),
              },
              grant: OWN_GRANT,
              ...(name === "Malformed progress"
                ? { progress: malformed[variant as keyof typeof malformed] }
                : {}),
              ...(variant === "inactive" ? { active: false } : {}),
              ...(variant === "release pending"
                ? { releaseNeeded: true, releaseRequestId: "release-1" }
                : {}),
            });
          },
          steps: [() => answer({ ...ISSUE, lease })],
        },
        async (r) => {
          const invoke = (op: string, input: object) =>
            r.assembly.catalog.invoke(
              r.request(
                op,
                { id: ISSUE.id, ...input },
                {
                  context: holding(
                    r,
                    op === "lane.record"
                      ? { leaseGeneration: recordingGeneration }
                      : {},
                  ),
                },
              ),
            );
          const next = (at = head) => invoke("lane.next", { head: at });
          const record = (result: object, action = 1) =>
            invoke("lane.record", { action, result: JSON.stringify(result) });
          const saved = async () => {
            const state = new LocalState(
              join(r.s.deviceRoot, "records.sqlite"),
            );
            try {
              return (await state.open(false))!.get(
                "forge/work",
                journalKey(),
              )!;
            } finally {
              await state.close();
            }
          };
          const original = await saved();
          if (variant === "hostile ask") {
            const ask = {
              reason: "Choose\nScope\u001b\u202e",
              releaseTotal: "400\u200b lines",
              default: "A\tkeep",
            };
            expect((await next()).ok).toBe(true);
            expect((await record({ head, ask })).ok).toBe(true);
            const before = await saved();
            const shown = await next();
            expect(shown).toMatchObject({
              ok: true,
              status: "OK",
              result: { kind: "ask-owner" },
            });
            expect(exitCode(shown)).toBe(0);
            expect(before.value).toHaveProperty("progress.ask", ask);
            expect(await saved()).toEqual(before);
            if (!shown.ok) throw new Error("The bound ask was not shown");
            const display = (shown.result as { ask: string }).ask;
            const savedAsk = readBoundLane(before.value, "work-1").progress
              ?.ask;
            expect(display).toBe(escapeDisplayText(JSON.stringify(savedAsk)));
            expect(JSON.parse(display)).toEqual(ask);
            return;
          }
          const projectFiles = () =>
            bytes(r.s).filter(([path]) => String(path).startsWith("project"));
          let files = projectFiles();
          if (name === "Same pending next" && variant === "revision race") {
            const race = await initialReservationRace(r, coordinateLane);
            expect(race.replies[0]).toEqual(race.replies[1]);
            expect(race.replies[0]).toMatchObject({
              status: "fulfilled",
              value: { n: 1 },
            });
            expect(race.saved.revision).toBe(2);
            expect(race.saved.value).toHaveProperty("progress.actions", 1);
            expect(race.writes).toBe(1);
            // Execute the same race with the serialization predecessor removed.
            const path = new URL(
              "../../src/assembly/cloud-lane-coordinator.ts",
              import.meta.url,
            );
            const source = readFileSync(path, "utf8");
            const mutated = source.replace(
              "await promise;",
              "await Promise.resolve();",
            );
            expect(mutated).not.toBe(source);
            const absolute = mutated.replace(
              /from "(\.[^"]+)"/g,
              (_all, specifier: string) =>
                `from "${new URL(specifier, pathToFileURL(fileURLToPath(path))).href}"`,
            );
            const javascript = new Bun.Transpiler({
              loader: "ts",
            }).transformSync(absolute);
            const mutant = (await import(
              `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
            )) as typeof import("../../src/assembly/cloud-lane-coordinator.ts");
            const unsafe = await initialReservationRace(
              r,
              mutant.coordinateLane,
            );
            expect(
              unsafe.replies.some((reply) => reply.status === "rejected"),
            ).toBe(true);
            expect(unsafe.writes).toBe(2);
          } else if (
            name === "Same pending next" &&
            variant === "missing head"
          ) {
            expect(failed(await invoke("lane.next", {}), "INPUT_INVALID")).toBe(
              6,
            );
            expect(await saved()).toEqual(original);
            expect(r.net.calls).toHaveLength(0);
          } else if (name === "Malformed progress") {
            expect(failed(await next(), "INPUT_CONFLICT")).toBe(4);
            expect(await saved()).toEqual(original);
          } else if (name === "Expired or replaced grant") {
            if (variant === "renewal failure") {
              expect(await next()).toMatchObject({
                ok: true,
                result: { kind: "harness" },
              });
              const reserved = await saved();
              const boundary = boundDispatch(
                () => Promise.reject(new Error("renewal timeout")),
                "work-1",
                lease.generation,
              );
              await expect(boundary.beforeSpawn()).rejects.toThrow(
                "renewal timeout",
              );
              await expect(boundary.beforeSpawn()).rejects.toThrow(
                "renewal timeout",
              );
              time = Date.parse(lease.expiresAt);
              expect(failed(await next(), "LEASE_EXPIRED")).toBe(4);
              expect(await saved()).toEqual(reserved);
              await boundary.close();
              return;
            }
            if (variant === "expired") time = Date.parse(lease.expiresAt);
            if (variant === "generation")
              lease = { ...lease, generation: lease.generation + 1 };
            if (variant === "holder") lease = heldBy();
            const code =
              variant === "expired"
                ? "LEASE_EXPIRED"
                : variant === "generation"
                  ? "LEASE_STALE"
                  : variant === "holder"
                    ? "LEASE_NOT_HELD"
                    : "INPUT_CONFLICT";
            expect(failed(await next(), code)).toBe(4);
            expect(await saved()).toEqual(original);
          } else {
            const first = await next();
            expect(first).toMatchObject({
              ok: true,
              status: "OK",
              result: {
                n: variant === "disabled" ? 0 : 1,
                kind: variant === "disabled" ? "pause" : "harness",
              },
            });
            expect(exitCode(first)).toBe(0);
            if (name === "Same pending next") {
              const reserved = await saved();
              if (variant === "restart") {
                const clone = await r.open();
                try {
                  expect(
                    await clone.catalog.invoke(
                      r.request(
                        "lane.next",
                        { id: ISSUE.id, head },
                        {
                          context: {
                            ...holding(r),
                            project: localContext(clone, {
                              kind: "agent",
                              id: "a1",
                            }).project!,
                          },
                        },
                      ),
                    ),
                  ).toEqual(first);
                } finally {
                  await clone.close();
                }
              } else expect(await next()).toEqual(first);
              expect(await saved()).toEqual(reserved);
            } else if (variant.startsWith("checkout ")) {
              const ask = {
                reason: "Scope",
                releaseTotal: "400 lines",
                default: "A",
              };
              if (variant === "checkout answer")
                expect((await record({ head, ask })).ok).toBe(true);
              const before = await saved();
              checkoutHead = moved;
              const late =
                variant === "checkout verdict"
                  ? await invoke("lane.record", {
                      mergeGate: { head, verdict: "MERGE", reviewer: "old" },
                    })
                  : await record({
                      head,
                      ...(variant === "checkout ask"
                        ? { ask }
                        : variant === "checkout answer"
                          ? { answer: "hold" }
                          : { done: true }),
                    });
              expect(failed(late, "INPUT_CONFLICT")).toBe(4);
              expect(await saved()).toEqual(before);
            } else if (
              name === "Old verdict/result" &&
              !["verdict", "result", "generation", "head replay"].includes(
                variant,
              )
            ) {
              // Same holder, head and action number: only the reservation generation distinguishes the late request.
              const late = r.request(
                "lane.record",
                variant !== "reattach result"
                  ? {
                      id: ISSUE.id,
                      mergeGate: { head, verdict: "MERGE", reviewer: "old" },
                    }
                  : {
                      id: ISSUE.id,
                      action: 1,
                      result: readFileSync(
                        join(r.s.root, "old-result.log"),
                        "utf8",
                      ),
                    },
                {
                  context: holding(
                    r,
                    variant === "generation counterfactual"
                      ? {}
                      : { leaseGeneration: lease.generation },
                  ),
                },
              );
              lease = { ...lease, generation: lease.generation + 1 };
              recordingGeneration = lease.generation;
              expect(
                (
                  await invoke("lane.start", {
                    branch: "feat/one",
                    brief: "brief.md",
                  })
                ).ok,
              ).toBe(true);
              expect(await next()).toMatchObject({
                ok: true,
                result: { n: 2 },
              });
              const reserved = await saved();
              files = projectFiles();
              expect(
                failed(await r.assembly.catalog.invoke(late), "INPUT_CONFLICT"),
              ).toBe(4);
              expect(await saved()).toEqual(reserved);
              expect(
                readFileSync(join(r.s.root, "old-result.log"), "utf8"),
              ).toBe(JSON.stringify({ head, done: true }));
              // Without the generation fence the otherwise identical old verdict is admitted.
              if (variant === "reattach result")
                expect((await record({ head, done: true }, 2)).ok).toBe(true);
              else
                expect(
                  (
                    await r.assembly.catalog.invoke({
                      ...late,
                      context: holding(r, {
                        leaseGeneration: lease.generation,
                      }),
                    })
                  ).ok,
                ).toBe(true);
            } else if (name === "Old verdict/result") {
              expect(
                (
                  await invoke("lane.record", {
                    mergeGate: { head, verdict: "MERGE", reviewer: "reviewer" },
                  })
                ).ok,
              ).toBe(true);
              expect((await saved()).value).toHaveProperty(
                "progress.verdict.head",
                head,
              );
              checkoutHead = moved;
              expect((await next(moved)).ok).toBe(true);
              let changed = await saved();
              expect(changed.value).not.toHaveProperty("progress.verdict");
              if (variant === "head replay") {
                expect(
                  (
                    await invoke("lane.record", {
                      mergeGate: {
                        head: moved,
                        verdict: "MERGE",
                        reviewer: "new",
                      },
                    })
                  ).ok,
                ).toBe(true);
                const reviewed = await saved();
                expect(failed(await next(head), "INPUT_CONFLICT")).toBe(4);
                expect(await saved()).toEqual(reviewed);
                expect(
                  failed(await record({ head, done: true }), "INPUT_CONFLICT"),
                ).toBe(4);
                expect(
                  failed(
                    await invoke("lane.record", {
                      mergeGate: { head, verdict: "MERGE", reviewer: "old" },
                    }),
                    "INPUT_CONFLICT",
                  ),
                ).toBe(4);
                expect(await saved()).toEqual(reviewed);
                changed = reviewed;
              }
              if (variant === "generation")
                lease = { ...lease, generation: lease.generation + 1 };
              const old =
                variant === "verdict"
                  ? await invoke("lane.record", {
                      mergeGate: { head, verdict: "MERGE", reviewer: "old" },
                    })
                  : await record({ head, done: true });
              expect(
                failed(
                  old,
                  variant === "generation" ? "LEASE_STALE" : "INPUT_CONFLICT",
                ),
              ).toBe(4);
              expect(await saved()).toEqual(changed);
            } else if (name === "Budget reached") {
              const ask = {
                reason: "Scope",
                releaseTotal: "400 lines",
                default: "A",
              };
              if (variant.endsWith("held")) {
                expect((await record({ head, ask })).ok).toBe(true);
                expect((await record({ head, answer: "hold" })).ok).toBe(true);
              }
              if (variant !== "disabled" && variant !== "pending time") {
                expect(
                  (
                    await record({
                      head,
                      done: true,
                      ...(variant.includes("review") ? { review: true } : {}),
                      ...(variant.includes("ci") ? { ci: true } : {}),
                      ...(variant.endsWith("ask") || variant.endsWith("retry")
                        ? { ask }
                        : {}),
                    })
                  ).ok,
                ).toBe(true);
                if (variant.endsWith("retry")) {
                  expect((await record({ head, review: true, ask })).ok).toBe(
                    true,
                  );
                  expect((await saved()).value).toHaveProperty(
                    "progress.review",
                    1,
                  );
                }
                if (["activeHours", "regrant time"].includes(variant)) {
                  time += 3_600_000;
                  lease = { ...lease, expiresAt: iso(time + 60_000) };
                }
              }
              if (variant === "pending time") {
                // The authority renewed this generation while its reservation stayed pending.
                time += 3_600_000;
                lease = { ...lease, expiresAt: iso(time + 60_000) };
              }
              if (variant.startsWith("regrant ")) {
                lease = { ...lease, generation: lease.generation + 1 };
                expect(
                  (
                    await invoke("lane.start", {
                      branch: "feat/one",
                      brief: "brief.md",
                    })
                  ).ok,
                ).toBe(true);
                expect((await saved()).value).toHaveProperty(
                  "progress.actions",
                  1,
                );
                files = projectFiles();
              }
              const before = await saved();
              const paused = await next();
              expect(paused).toMatchObject({
                ok: true,
                status: "OK",
                result: { kind: "pause" },
              });
              expect(exitCode(paused)).toBe(0);
              expect(await saved()).toEqual(before);
            } else {
              const ask = {
                reason: "Choose scope",
                releaseTotal: "400 lines",
                default: "A: smallest slice",
              };
              expect((await record({ head, ask })).ok).toBe(true);
              expect(await next()).toMatchObject({
                ok: true,
                result: {
                  kind: "ask-owner",
                  ask: expect.stringContaining("400 lines") as unknown,
                },
              });
              if (variant !== "ask") {
                expect((await record({ head, answer: "hold" })).ok).toBe(true);
                if (variant === "completion after hold")
                  expect((await record({ head, done: true })).ok).toBe(true);
                expect(await next()).toMatchObject({
                  ok: true,
                  result: { kind: "pause" },
                });
                expect((await saved()).value).toHaveProperty(
                  "progress.ask.answer",
                  "hold",
                );
              }
            }
          }
          expect(projectFiles()).toEqual(files);
          expect(
            r.net.calls.every(
              ({ body }) => (body as { op: string }).op === "issue.show",
            ),
          ).toBe(true);
        },
      );
    }
  });
test("bound attachment: concurrent clones reserve before registry publication", async () => {
  for (const guarded of [true, false]) {
    const s = fx.sandbox();
    const local = new LocalState(join(s.deviceRoot, "records.sqlite"));
    try {
      const owner = (await local.open(true))!;
      const client = owner.client("forge/work", OWN_GRANT.holder.actor);
      const barrier = Promise.withResolvers<void>();
      const project = fx.bindingFor(),
        registry = "forge-lanes.json";
      let entered = 0;
      const registries = [s.root, s.home];
      const mutant = guarded
        ? undefined
        : await fx.withoutGuard<typeof boundLane>(
            new URL("../../src/blocks/work/bound-lane.ts", import.meta.url),
            "revision = store.save(record, revision).revision;",
          );
      if (mutant) expect(mutant.mutationLoaded).toBe(true);
      const start = mutant?.boundLaneStart ?? boundLane.boundLaneStart;
      const replies = await Promise.allSettled(
        registries.map((root) =>
          start(
            { id: ISSUE.id, branch: "feat/one", brief: "brief.md" },
            { ...OWN_GRANT.holder, project: { id: "fixture", root } },
            "dev-1",
            () => NOW,
            project,
            client,
            () => Promise.resolve({ ...ISSUE, lease: OWN_GRANT }),
            () =>
              Promise.resolve({
                save: (r, v) => writeBoundLane(client, project, r, v),
                restore: () => expect.unreachable("Unexpected rollback"),
              }),
            async (record, fence) => {
              if (++entered === 2) barrier.resolve();
              await barrier.promise;
              const lane = {
                ...record.lane,
                gitScope: scopedGit.createGitScope(root),
              };
              await fence.publish(
                lane,
                () => writeFileSync(join(root, registry), "attached"),
                () => true,
              );
              return lane;
            },
          ),
        ),
      );
      expect(replies.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = replies.findIndex((r) => r.status === "rejected");
      expect(existsSync(join(registries[loser]!, registry))).toBe(!guarded);
      const winner = 1 - loser;
      expect(
        readBoundLane(client.get(journalKey())!.value, "work-1"),
      ).toMatchObject({ active: true, lane: { worktree: registries[winner] } });
    } finally {
      await local.close();
      s.close();
    }
  }
});
const malformedRegistryScopes = [
  null,
  {},
  { project: { lexical: "/project", real: "/project" } },
  ...(process.platform === "win32"
    ? ["/project", "\\project", "\\\\server", "\\\\server\\", "//server/"].map(
        (path) => ({
          project: { lexical: path, real: path },
          lane: { lexical: path, real: path },
        }),
      )
    : []),
];
for (const [name, expected] of [
  ["ordinary attachment", "OK"],
  ...malformedRegistryScopes.map(
    (scope) =>
      [
        `malformed registry saved roots: ${JSON.stringify(scope)}`,
        "INPUT_INVALID",
      ] as const,
  ),
  ["retargeted saved project journal", "INPUT_CONFLICT"],
  ["retargeted saved project registry", "INPUT_CONFLICT"],
  ["symlink attachment", "OK"],
  ["Drop-lexical-on-save", "OK"],
  ["project git precedes trusted git", "OK"],
  ["failed restart preserves attachment", "OK"],
  ["live attachment different checkout", "INPUT_CONFLICT"],
  ["live attachment different branch", "INPUT_CONFLICT"],
  ["live attachment different brief", "INPUT_CONFLICT"],
  ["live attachment same identity", "OK"],
  ["stale attachment dispatch", "OK"],
  ["wrong actor", "LEASE_NOT_HELD"],
  ["wrong session", "LEASE_NOT_HELD"],
  ["wrong device", "AUTH_DEVICE_MISMATCH"],
  ["grant belongs to another device", "LEASE_NOT_HELD"],
  ["wrong generation", "LEASE_STALE"],
  ["wrong registry path", "INPUT_CONFLICT"],
  ["wrong Git branch", "INPUT_CONFLICT"],
  ["nested directory", "INPUT_CONFLICT"],
  ["branch changes during fence", "INPUT_CONFLICT"],
  ["holder changes during fence", "LEASE_NOT_HELD"],
  ["generation changes during fence", "LEASE_STALE"],
  ["grant expires during fence", "LEASE_EXPIRED"],
  ["grant expires during final identity", "LEASE_EXPIRED"],
  ["released and reclaimed during final identity", "LEASE_NOT_HELD"],
  ["unknown grant during final identity", "UNAVAILABLE"],
  ["grant changes during writable prepare", "LEASE_NOT_HELD"],
  ["registry lock rolls back reservation", "INPUT_CONFLICT"],
  ["registry lock rollback counterfactual", "INPUT_CONFLICT"],
  ["registry cleanup leaves pending reservation", "INPUT_CONFLICT"],
  ["invalid brief", "INPUT_INVALID"],
  ["closed issue", "INPUT_CONFLICT"],
  ["absent issue", "NOT_FOUND"],
  ["ambiguous claim", "UNAVAILABLE"],
  ["losing claim", "LEASE_NOT_HELD"],
] as const)
  test(`bound attachment table: ${name}`, () => {
    const lexicalAttachment = [
      "symlink attachment",
      "Drop-lexical-on-save",
    ].includes(name);
    const malformedRegistry = name.startsWith(
      "malformed registry saved roots:",
    );
    const retargetedProject = name.startsWith("retargeted saved project");
    const malformedScope: unknown = malformedRegistry
      ? JSON.parse(name.slice(name.indexOf(":") + 1))
      : null;
    const live = name.startsWith("live attachment");
    const registryFailure = name.startsWith("registry ");
    const cleanupFailure = name.startsWith("registry cleanup");
    let reads = 0;
    let time = NOW;
    let finalIdentity = false;
    let prepared = false;
    let cloudGrant: LeaseRecord | undefined = OWN_GRANT;
    let priorJournal: unknown;
    let sandbox: fx.Sandbox;
    let lexicalFixture: ReturnType<typeof fx.persistedRootsFixture> | undefined;
    return using(
      {
        config: yaml({ config: { idPrefix: "forge" } }),
        now: () => time,
        prepare: async (s) => {
          sandbox = s;
          if (lexicalAttachment) {
            lexicalFixture = fx.persistedRootsFixture();
            rmSync(lexicalFixture.alias, { recursive: true });
            fx.directoryLink(s.dir, lexicalFixture.alias);
            fx.directoryLink(
              join(lexicalFixture.project, "bin"),
              join(s.root, "bin"),
            );
            lexicalFixture.env.PATH = lexicalFixture.env.PATH.replace(
              join(lexicalFixture.project, "bin"),
              join(lexicalFixture.alias, "project", "bin"),
            );
          }
          const git = spawnSync(
            "git",
            ["init", "--quiet", "--initial-branch=feat/one", s.root],
            { encoding: "utf8", windowsHide: true },
          );
          expect(git.status, git.stderr).toBe(0);
          if (name === "project git precedes trusted git") {
            const bin = join(s.root, "node_modules", ".bin");
            mkdirSync(bin, { recursive: true });
            writeFileSync(
              join(bin, process.platform === "win32" ? "git.cmd" : "git"),
              process.platform === "win32"
                ? "@echo off\r\necho ran>project-git-ran\r\nexit /b 99\r\n"
                : "#!/bin/sh\nprintf ran > project-git-ran\nexit 99\n",
              { mode: 0o755 },
            );
          }
          writeFileSync(
            join(s.root, "brief.md"),
            name === "invalid brief" ? "incomplete" : PREPARED_BRIEF,
          );
          if (name === "nested directory") {
            mkdirSync(join(s.root, "src", ".forge"), { recursive: true });
            cpSync(
              join(s.root, ".forge", "config.yaml"),
              join(s.root, "src", ".forge", "config.yaml"),
            );
            cpSync(join(s.root, "brief.md"), join(s.root, "src", "brief.md"));
          }
          if (name === "wrong registry path")
            writeFileSync(
              join(s.root, ".git", "forge-lanes.json"),
              JSON.stringify([
                {
                  ...attachment,
                  worktree: "/foreign",
                  brief: join(s.root, "brief.md"),
                },
              ]),
            );
          if (live) {
            const lane = {
              ...attachment,
              worktree: name.endsWith("checkout")
                ? join(s.dir, "clone-a")
                : realpathSync.native(s.root),
              branch: name.endsWith("branch") ? "feat/original" : "feat/one",
              brief: name.endsWith("brief") ? "original.md" : "brief.md",
            };
            await seedJournal(s, {
              ...journal,
              grant: OWN_GRANT,
              releaseNeeded: true,
              lane,
              progress: {
                generation: 4,
                actions: 1,
                records: 0,
                review: 0,
                ci: 0,
                started: NOW,
                pending: true,
                head: "a".repeat(40),
              },
            });
          } else if (
            expected !== "OK" &&
            !["ambiguous claim", "losing claim"].includes(name) &&
            !cleanupFailure
          ) {
            priorJournal = {
              ...journal,
              grant: OWN_GRANT,
              active: false,
              releaseNeeded: !registryFailure,
              lane: { ...attachment, worktree: realpathSync.native(s.root) },
            };
            if (malformedRegistry || retargetedProject) {
              const fresh = scopedGit.createGitScope(s.root);
              const lane = {
                ...attachment,
                worktree: fresh.lane.real,
                brief: join(fresh.lane.real, "brief.md"),
                gitScope: fresh,
              };
              if (retargetedProject) {
                const alias = join(s.dir, "saved-project"),
                  replacement = join(s.dir, "replacement");
                fx.directoryLink(s.root, alias);
                const scope = scopedGit.createGitScope(alias, s.root);
                if (name.endsWith("journal")) lane.gitScope = scope;
                const registered = {
                  ...lane,
                  gitScope: name.endsWith("registry") ? scope : fresh,
                };
                writeFileSync(
                  join(s.root, ".git", "forge-lanes.json"),
                  JSON.stringify([registered]),
                );
                mkdirSync(replacement);
                rmSync(alias, { recursive: true });
                fx.directoryLink(replacement, alias);
              }
              priorJournal = { ...journal, grant: OWN_GRANT, lane };
            }
            await seedJournal(s, priorJournal);
          }
          if (malformedRegistry)
            writeFileSync(
              join(s.root, ".git", "forge-lanes.json"),
              JSON.stringify([{ ...attachment, gitScope: malformedScope }]),
            );
          if (registryFailure && !cleanupFailure)
            writeFileSync(
              join(s.root, ".git", "forge-lanes.json.lock"),
              "held",
            );
        },
        steps: [
          ({ body }) => {
            const call = body as { op: string };
            if (call.op === "issue.release")
              return answer({ id: ISSUE.id }, call.op);
            if (call.op === "issue.claim") {
              if (name === "ambiguous claim")
                throw new Error("accepted then timed out");
              if (name === "losing claim") return refusing("LEASE_HELD");
              return answer(
                {
                  id: ISSUE.id,
                  generation: OWN_GRANT.generation,
                  expiresAt: OWN_GRANT.expiresAt,
                },
                call.op,
              );
            }
            expect(call.op).toBe("issue.show");
            reads++;
            if (finalIdentity && name === "unknown grant during final identity")
              throw new Error("fresh grant read timed out");
            if (reads === 2 && name === "branch changes during fence") {
              const changed = spawnSync(
                "git",
                [
                  "-C",
                  sandbox.root,
                  "symbolic-ref",
                  "HEAD",
                  "refs/heads/feat/other",
                ],
                { encoding: "utf8", windowsHide: true },
              );
              expect(changed.status, changed.stderr).toBe(0);
            }
            const lease =
              name === "losing claim"
                ? heldBy()
                : name === "grant belongs to another device"
                  ? {
                      ...OWN_GRANT,
                      holder: {
                        ...OWN_GRANT.holder,
                        session: {
                          ...OWN_GRANT.holder.session,
                          device: "other",
                        },
                      },
                    }
                  : reads === 2 && name === "holder changes during fence"
                    ? heldBy()
                    : reads === 2 && name === "generation changes during fence"
                      ? { ...OWN_GRANT, generation: OWN_GRANT.generation + 1 }
                      : reads === 2 && name === "grant expires during fence"
                        ? { ...OWN_GRANT, expiresAt: iso(NOW - 1) }
                        : prepared &&
                            name === "grant changes during writable prepare"
                          ? { ...heldBy(), generation: 5 }
                          : finalIdentity &&
                              name ===
                                "released and reclaimed during final identity"
                            ? { ...heldBy(), generation: 5 }
                            : OWN_GRANT;
            return name === "absent issue"
              ? refusing("NOT_FOUND")
              : answer({
                  ...ISSUE,
                  status: name === "closed issue" ? "closed" : "open",
                  lease,
                });
          },
        ],
      },
      async (r) => {
        const assembly = lexicalAttachment
          ? await r.open(join(lexicalFixture!.alias, "project"))
          : name === "nested directory"
            ? await r.open(join(r.s.root, "src"))
            : r.assembly;
        const dropLexical =
          name === "Drop-lexical-on-save"
            ? await fx.withoutGuard<typeof boundLane>(
                new URL("../../src/blocks/work/bound-lane.ts", import.meta.url),
                "      gitScope,\n      brief:",
                "      gitScope: {project:{...gitScope.project,lexical:gitScope.project.real},lane:{...gitScope.lane,lexical:gitScope.lane.real}},\n      brief:",
              )
            : undefined;
        if (dropLexical) expect(dropLexical.mutationLoaded).toBe(true);
        const dropSpy = dropLexical
          ? spyOn(boundLane, "attachBoundLane").mockImplementation(
              dropLexical.attachBoundLane,
            )
          : undefined;
        const runProcess = launch.runProcess;
        const exclusive = durable.publishExclusive;
        const cleanupSpy = cleanupFailure
          ? spyOn(durable, "publishExclusive").mockImplementation(
              (from, to) => {
                exclusive(from, to);
                if (to.endsWith("forge-lanes.json"))
                  throw new ForgeFailure({
                    code: "INPUT_CONFLICT",
                    message: "post-publication cleanup failed",
                    retry: "reconcile_first",
                  });
              },
            )
          : undefined;
        const noRollback =
          name === "registry lock rollback counterfactual"
            ? await fx.withoutGuard<typeof boundLane>(
                new URL("../../src/blocks/work/bound-lane.ts", import.meta.url),
                "if (unpublished()) store.restore(previous, revision);",
              )
            : undefined;
        if (noRollback) expect(noRollback.mutationLoaded).toBe(true);
        const rollbackSpy = noRollback
          ? spyOn(boundLane, "boundLaneStart").mockImplementation(
              noRollback.boundLaneStart,
            )
          : undefined;
        const openStore = Reflect.get(LocalState.prototype, "open");
        const promotion =
          name === "grant changes during writable prepare"
            ? spyOn(LocalState.prototype, "open").mockImplementation(
                async function (this: LocalState, write) {
                  const result = await openStore.call(this, write);
                  if (write && !prepared) {
                    await Promise.resolve();
                    prepared = true;
                  }
                  return result;
                },
              )
            : undefined;
        const projectGit =
          name === "project git precedes trusted git" || malformedRegistry
            ? spyOn(launch, "runProcess")
            : undefined;
        const expiry = name.includes("during final identity")
          ? spyOn(launch, "runProcess").mockImplementation(async (...args) => {
              const result = await runProcess(...args);
              if (reads === 2 && args[1][0] === "symbolic-ref") {
                finalIdentity = true;
                if (name === "grant expires during final identity")
                  time = Date.parse(OWN_GRANT.expiresAt);
              }
              return result;
            })
          : undefined;
        let effects = () => [-1, -1];
        let beforeRepeat: ReturnType<typeof bytes> = [];
        const marker = join(r.s.root, "identity-launched");
        const nativeAttach = boundLane.attachBoundLane;
        const repeatProbe = retargetedProject
          ? spyOn(boundLane, "attachBoundLane").mockImplementation(
              (...args) => {
                const services = args[1];
                beforeRepeat = bytes(r.s);
                const lock = spyOn(services.files, "lock"),
                  write = spyOn(services.files, "write");
                effects = () => [
                  lock.mock.calls.length,
                  write.mock.calls.length,
                ];
                const run = services.process.run.bind(services.process);
                spyOn(services.process, "run").mockImplementation((...args) => {
                  writeFileSync(marker, "launched");
                  return run(...args);
                });
                return nativeAttach(...args);
              },
            )
          : undefined;
        try {
          if (projectGit) {
            const providers = createAssemblyProviders(r.s.root, {
              env: {
                ...r.env,
                PATH: `${join(r.s.root, "node_modules", ".bin")}${delimiter}${r.env.PATH}`,
              },
            });
            const scope = {
              op: "lane.start",
              effects: [
                "files:read",
                "files:write",
                "environment:read",
                "external:process",
              ],
              signal: AbortSignal.timeout(30000),
              deadline: Date.now() + 30000,
              processContainment: "supervised" as const,
            };
            const files = await providers.openFiles(scope);
            try {
              if (malformedRegistry)
                expect(validGitScope(malformedScope)).toBe(false);
              const lock = spyOn(files.value, "lock"),
                write = spyOn(files.value, "write");
              if (malformedRegistry)
                projectGit.mockImplementation(async (...args) => {
                  writeFileSync(marker, "launched");
                  return runProcess(...args);
                });
              const before = bytes(r.s);
              const attempt = attachBoundLane(
                readBoundLane(
                  priorJournal ?? { ...journal, grant: OWN_GRANT },
                  "work-1",
                ),
                {
                  files: files.value,
                  process: providers.process(scope),
                  environment: providers.environment(scope),
                  now: () => NOW,
                  ...scope,
                },
                {
                  check: async () => {},
                  publish: (_lane, write) => Promise.resolve(write()),
                },
              );
              if (malformedRegistry) {
                await expect(attempt).rejects.toMatchObject({
                  error: { code: "INPUT_INVALID" },
                });
                expect([
                  existsSync(marker),
                  lock.mock.calls.length,
                  write.mock.calls.length,
                  bytes(r.s),
                ]).toEqual([false, 0, 0, before]);
                return;
              }
              const lane = await attempt;
              expect(lane.branch).toBe("feat/one");
              expect(existsSync(join(r.s.root, "project-git-ran"))).toBe(false);
              expect([
                ...new Set(
                  projectGit.mock.calls.map(([executable]) => executable),
                ),
              ]).toEqual([gitExecutable()]);
            } finally {
              await files.close();
            }
            return;
          }
          const context = {
            ...holding(r, { leaseGeneration: OWN_GRANT.generation }),
            project: localContext(assembly, { kind: "agent", id: "a1" })
              .project!,
          };
          const before = attachmentBytes(r.s);
          const start = () =>
            assembly.catalog.invoke(
              r.request(
                "lane.start",
                { id: ISSUE.id, branch: "feat/one", brief: "brief.md" },
                { context },
              ),
            );
          const beforeFiles = readFileSync(join(r.s.root, "brief.md"), "utf8");
          const claimed = await assembly.catalog.invoke(
            r.request("issue.claim", { id: ISSUE.id }, { context }),
          );
          if (name === "ambiguous claim" || name === "losing claim") {
            expect(
              failed(
                claimed,
                name === "losing claim" ? "LEASE_HELD" : expected,
              ),
            ).toBe(name === "losing claim" ? 4 : 1);
            expect(attachmentBytes(r.s)).toEqual(before);
            if (name === "ambiguous claim") return;
          } else expect(claimed.ok).toBe(true);
          if (name === "ordinary attachment") {
            const rejected = await assembly.catalog.invoke(
              r.request(
                "lane.start",
                {
                  id: ISSUE.id,
                  branch: "feat/other",
                  brief: "brief.md",
                },
                { context },
              ),
            );
            expect(failed(rejected, "INPUT_CONFLICT")).toBe(4);
            const local = new LocalState(
              join(r.s.deviceRoot, "records.sqlite"),
            );
            try {
              expect(await local.open(false)).toBeUndefined();
            } finally {
              await local.close();
            }
            expect(attachmentBytes(r.s)[1]).toBe(before[1]);
          }
          const altered =
            name === "wrong actor"
              ? { ...context, actor: { kind: "agent" as const, id: "other" } }
              : name === "wrong session"
                ? { ...context, session: { id: "other" } }
                : name === "wrong device"
                  ? { ...context, device: { id: "other" } }
                  : name === "wrong generation"
                    ? { ...context, leaseGeneration: 99 }
                    : context;
          const result = await assembly.catalog.invoke(
            r.request(
              "lane.start",
              {
                id: ISSUE.id,
                branch: name === "wrong Git branch" ? "feat/other" : "feat/one",
                brief: "brief.md",
              },
              { context: altered },
            ),
          );
          if (name.includes("during final identity"))
            expect(finalIdentity).toBe(true);
          expect(result.ok ? "OK" : result.error.code).toBe(expected);
          if (retargetedProject)
            expect([existsSync(marker), ...effects(), bytes(r.s)]).toEqual([
              false,
              0,
              0,
              beforeRepeat,
            ]);
          expect(readFileSync(join(r.s.root, "brief.md"), "utf8")).toBe(
            beforeFiles,
          );
          expect(existsSync(join(r.s.root, ".forge", "state.sqlite"))).toBe(
            false,
          );
          if (expected !== "OK") {
            if (registryFailure) {
              const local = new LocalState(
                join(r.s.deviceRoot, "records.sqlite"),
              );
              try {
                const state = (await local.open(false))!;
                const restored = state.get("forge/work", journalKey())!.value;
                if (noRollback || cleanupFailure)
                  expect(restored).toMatchObject({
                    active: false,
                    releaseNeeded: true,
                  });
                else expect(restored).toEqual(priorJournal);
              } finally {
                await local.close();
              }
              if (cleanupFailure) {
                expect(attachmentBytes(r.s)[1]).not.toBeNull();
                const released = await assembly.catalog.invoke(
                  r.request("lane.release", { id: ISSUE.id }, { context }),
                );
                expect(released.ok, JSON.stringify(released)).toBe(true);
                return;
              }
              rmSync(join(r.s.root, ".git", "forge-lanes.json.lock"));
              expect(
                spawnSync(
                  "git",
                  ["-C", r.s.root, "checkout", "-b", "feat/other"],
                  { windowsHide: true },
                ).status,
              ).toBe(0);
              const retry = await assembly.catalog.invoke(
                r.request(
                  "lane.start",
                  { id: ISSUE.id, branch: "feat/other", brief: "brief.md" },
                  { context },
                ),
              );
              expect(retry.ok, JSON.stringify(retry)).toBe(!noRollback);
              return;
            }
            if (live || finalIdentity)
              expect(exitCode(result)).toBe(expected === "UNAVAILABLE" ? 1 : 4);
            if (name === "grant expires during final identity")
              expect(time).toBe(Date.parse(OWN_GRANT.expiresAt));
            expect(attachmentBytes(r.s)).toEqual(before);
            expect(
              r.net.calls.some(
                (call) => (call.body as { op: string }).op === "issue.release",
              ),
            ).toBe(false);
            if (
              (live ||
                finalIdentity ||
                name === "grant changes during writable prepare") &&
              expected !== "LEASE_EXPIRED"
            ) {
              const mutant = await fx.withoutGuard<typeof boundLane>(
                new URL("../../src/blocks/work/bound-lane.ts", import.meta.url),
                live
                  ? "if (\n      previous &&"
                  : "const store = await prepare(id);\n      await fence.check();",
                live
                  ? "if (\n      false &&"
                  : name === "grant changes during writable prepare"
                    ? "await fence.check();\n      const store = await prepare(id);"
                    : "const store = await prepare(id);",
              );
              expect(mutant.mutationLoaded).toBe(true);
              expect(mutant.attachBoundLane).not.toBe(attachBoundLane);
              const key = live ? "attachBoundLane" : "boundLaneStart";
              const spy = spyOn(boundLane, key).mockImplementation(mutant[key]);
              reads = 0;
              finalIdentity = false;
              prepared = false;
              try {
                const unsafe = await start();
                expect(unsafe.ok, JSON.stringify(unsafe)).toBe(true);
              } finally {
                spy.mockRestore();
              }
            }
            return;
          }
          expect(result).toMatchObject({
            result: {
              branch: "feat/one",
              worktree: realpathSync.native(r.s.root),
              lease: OWN_GRANT,
            },
          });
          const roots = scopedGit.createGitScope(
            dropLexical
              ? realpathSync.native(r.s.root)
              : lexicalAttachment
                ? join(lexicalFixture!.alias, "project")
                : r.s.root,
          );
          expect(
            JSON.parse(
              readFileSync(join(r.s.root, ".git", "forge-lanes.json"), "utf8"),
            ),
          ).toEqual([
            {
              ...attachment,
              gitScope: roots,
              worktree: realpathSync.native(r.s.root),
              brief: `${realpathSync.native(r.s.root).replace(/\\/g, "/")}/brief.md`,
            },
          ]);
          const local = new LocalState(join(r.s.deviceRoot, "records.sqlite"));
          try {
            expect(
              (await local.open(false))!.get("forge/work", journalKey())!.value,
            ).toMatchObject({
              active: true,
              releaseNeeded: true,
              cloudId: ISSUE.id,
              grant: OWN_GRANT,
              lane: {
                gitScope: roots,
                worktree: realpathSync.native(r.s.root),
                branch: "feat/one",
              },
            });
            if (name === "live attachment same identity")
              expect(
                (await local.open(false))!.get("forge/work", journalKey())!
                  .value,
              ).toHaveProperty("progress.pending", true);
          } finally {
            await local.close();
          }
          if (lexicalFixture) {
            const registry = JSON.parse(
              readFileSync(join(r.s.root, ".git", "forge-lanes.json"), "utf8"),
            ) as { gitScope: scopedGit.GitScope }[];
            const root = join(lexicalFixture.alias, "project");
            const before = [attachmentBytes(r.s), ...lexicalFixture.snapshot()];
            for (const saved of [
              registry[0]!.gitScope,
              await startupScope.deviceGitScope(root, r.s.deviceRoot, r.s.home),
            ]) {
              const result = await fx.launchSavedGit(
                lexicalFixture,
                saved ?? null,
                scopedGit,
                root,
              );
              expect(result.exitCode).toBe(0);
            }
            expect(existsSync(lexicalFixture.marker)).toBe(false);
            expect([
              attachmentBytes(r.s),
              ...lexicalFixture.snapshot(),
            ]).toEqual(before);
          }
          if (name === "failed restart preserves attachment") {
            const before = bytes(r.s);
            const rejected = await assembly.catalog.invoke(
              r.request(
                "lane.start",
                { id: ISSUE.id, branch: "feat/other", brief: "brief.md" },
                { context },
              ),
            );
            expect(failed(rejected, "INPUT_CONFLICT")).toBe(4);
            expect(bytes(r.s)).toEqual(before);
            expect(
              await assembly.catalog.invoke(
                r.request("lane.show", { id: ISSUE.id }),
              ),
            ).toMatchObject({ ok: true, result: { branch: "feat/one" } });
            expect(
              await assembly.catalog.invoke(r.request("lane.status", {})),
            ).toMatchObject({
              ok: true,
              result: { lanes: [{ id: ISSUE.id, step: "attached" }] },
            });
          }
          if (name === "stale attachment dispatch") {
            cloudGrant = undefined;
            cloudGrant = { ...heldBy(), generation: 5 };
            let launches = 0;
            const send: boundLane.BoundCommand = async (op, _input, gen) => {
              await Promise.resolve();
              if (op === "issue.renew" && gen !== cloudGrant?.generation)
                throw new ForgeFailure({
                  code: "LEASE_STALE",
                  message: "Device B holds generation 5",
                  retry: "reconcile_first",
                });
              return { incarnation: "one", epoch: 1, stopped: false };
            };
            const timing = { now: () => NOW, schedule: () => () => {} };
            const boundary = boundDispatch(send, "work-1", 4, timing);
            await expect(
              boundary.beforeSpawn().then(() => launches++),
            ).rejects.toMatchObject({
              error: { code: "LEASE_STALE" },
            });
            expect(launches).toBe(0);
            await boundary.close();
            const mutant = await fx.withoutGuard<
              typeof import("../../tools/lane-control.ts")
            >(
              new URL("../../tools/lane-control.ts", import.meta.url),
              'command("issue.renew", { id }, generation)',
              "Promise.resolve({ generation, expiresAt: new Date(timing.now() + 60000).toISOString() })",
            );
            expect(mutant.mutationLoaded).toBe(true);
            const unfenced = mutant.boundDispatch(send, "work-1", 4, timing);
            await unfenced.beforeSpawn().then(() => launches++);
            expect(launches).toBe(1);
            await unfenced.close();
          }
        } finally {
          repeatProbe?.mockRestore();
          dropSpy?.mockRestore();
          cleanupSpy?.mockRestore();
          rollbackSpy?.mockRestore();
          promotion?.mockRestore();
          expiry?.mockRestore();
          projectGit?.mockRestore();
          if (assembly !== r.assembly) await assembly.close();
        }
      },
    ).finally(() => lexicalFixture?.close());
  });
for (const [name, code] of [
  ["malformed record", "INPUT_CONFLICT"],
  ["revision conflict", "REVISION_CONFLICT"],
] as const)
  test(`bound journal writer table: ${name}`, async () => {
    const s = fx.sandbox();
    const local = new LocalState(join(s.deviceRoot, "records.sqlite"));
    try {
      const client = (await local.open(true))!.client("forge/work", {
        kind: "agent",
        id: "a1",
      });
      const record = readBoundLane(journal, "work-1");
      writeBoundLane(client, fx.bindingFor(), record, 0);
      const before = attachmentBytes(s),
        events = client.events();
      expect(() =>
        writeBoundLane(
          client,
          fx.bindingFor(),
          name === "malformed record"
            ? { ...record, grant: { ...record.grant, generation: 0 } }
            : record,
          name === "revision conflict" ? 0 : 1,
        ),
      ).toThrow(code);
      expect(attachmentBytes(s)).toEqual(before);
      expect(client.events()).toEqual(events);
    } finally {
      await local.close();
      s.close();
    }
  });

for (const [name, variants] of [
  ["Explicit release while stopped", ["stopped"]],
  ["Release of another generation", ["cloud generation", "caller generation"]],
  [
    "Release by another holder",
    [
      "actor",
      "session",
      "device",
      "journal holder",
      "pending actor",
      "pending session",
    ],
  ],
  [
    "Lost release answer",
    [
      "accepted",
      "still held",
      "read unavailable",
      "replacement",
      "retry",
      "delayed original request",
    ],
  ],
  ["Release with no attachment", ["no journal", "unknown issue"]],
  ["Still refused", ["lane.close"]],
] as const)
  test(`bound release table: ${name}`, async () => {
    for (const variant of variants) {
      const grant = readBoundLane(
        { ...journal, grant: OWN_GRANT },
        "work-1",
      ).grant;
      let current: LeaseRecord | undefined =
        variant === "cloud generation"
          ? { ...grant, generation: grant.generation + 1 }
          : variant === "actor"
            ? {
                ...grant,
                holder: {
                  ...grant.holder,
                  actor: { kind: "agent", id: "other" },
                },
              }
            : variant === "session"
              ? {
                  ...grant,
                  holder: {
                    ...grant.holder,
                    session: { ...grant.holder.session, id: "other" },
                  },
                }
              : variant === "device"
                ? {
                    ...grant,
                    holder: {
                      ...grant.holder,
                      session: { ...grant.holder.session, device: "other" },
                    },
                  }
                : grant;
      if (variant.startsWith("pending ")) current = undefined;
      const pendingId = variant.startsWith("pending ")
        ? "release-original"
        : undefined;
      let releases = 0,
        reads = 0,
        stopped = false;
      let sandbox: fx.Sandbox, before: ReturnType<typeof attachmentBytes>;
      const releaseIds: string[] = [];
      const principals: LeaseRecord["holder"][] = [];
      const attached = {
        ...journal,
        grant: variant === "journal holder" ? heldBy() : grant,
        releaseNeeded: true,
      };
      const inspect = async () => {
        const local = new LocalState(
          join(sandbox.deviceRoot, "records.sqlite"),
        );
        try {
          return (await local.open(false))?.get("forge/work", journalKey())
            ?.value as Record<string, unknown> | undefined;
        } finally {
          await local.close();
        }
      };
      let effects = 0;
      const issue = { ...ISSUE, body: "retained cloud body" };
      await using(
        {
          prepare: async (s) => {
            sandbox = s;
            const git = spawnSync(
              "git",
              ["init", "--quiet", "--initial-branch=feat/one", s.root],
              { encoding: "utf8", windowsHide: true },
            );
            expect(git.status, git.stderr).toBe(0);
            attached.lane = {
              ...attachment,
              worktree: realpathSync.native(s.root),
              brief: `${realpathSync.native(s.root).replace(/\\/g, "/")}/brief.md`,
            };
            writeFileSync(join(s.root, "brief.md"), PREPARED_BRIEF);
            writeFileSync(join(s.root, "action.log"), "retained output");
            writeFileSync(
              join(s.root, ".git", "forge-lanes.json"),
              JSON.stringify([attached.lane]),
            );
            if (name !== "Release with no attachment")
              await seedJournal(s, {
                ...attached,
                ...(pendingId ? { releaseRequestId: pendingId } : {}),
              });
          },
          steps: [
            async ({ body }) => {
              const call = body as {
                op: string;
                requestId: string;
                input: { id?: string };
                context: {
                  leaseGeneration?: number;
                  actor: LeaseRecord["holder"]["actor"];
                  session: LeaseRecord["holder"]["session"];
                };
              };
              const value = await inspect();
              if (call.op === "issue.release" || value?.releaseRequestId) {
                const { releaseRequestId, ...unchanged } = value ?? {};
                expect(unchanged).toEqual(attached);
                expect(releaseRequestId).toBe(
                  releaseIds[0] ?? pendingId ?? call.requestId,
                );
                expect(attachmentBytes(sandbox)[1]).toBe(before[1]);
              } else expect(attachmentBytes(sandbox)).toEqual(before);
              if (call.op === "lane.stop") {
                stopped = true;
                return answer(
                  { incarnation: "cloud-1", epoch: 2, stopped },
                  call.op,
                );
              }
              if (call.op === "issue.release") {
                expect(call.input.id).toBe(journal.cloudId);
                expect(call.context.leaseGeneration).toBe(grant.generation);
                releases++;
                releaseIds.push(call.requestId);
                principals.push({
                  actor: call.context.actor,
                  session: call.context.session,
                });
                if (variant === "delayed original request" && releases === 2)
                  return call.requestId === releaseIds[0]
                    ? answer({ id: ISSUE.id }, call.op)
                    : refusing("LEASE_NOT_HELD");
                if (name === "Lost release answer") {
                  current = ["still held", "delayed original request"].includes(
                    variant,
                  )
                    ? grant
                    : variant === "replacement"
                      ? { ...grant, generation: grant.generation + 1 }
                      : undefined;
                  throw new Error("release reply lost");
                }
                current = undefined;
                return answer({ id: ISSUE.id }, call.op);
              }
              expect(call.op).toBe("issue.show");
              reads++;
              if (variant === "unknown issue") return refusing("NOT_FOUND");
              if (
                releases &&
                (variant === "read unavailable" || variant === "retry") &&
                reads === 2
              )
                throw new Error("authority unavailable");
              const response = answer({
                ...issue,
                ...(current ? { lease: current } : {}),
              });
              if (variant === "delayed original request" && reads === 3) {
                current = undefined;
                effects++;
              }
              return response;
            },
          ],
        },
        async (r) => {
          before = attachmentBytes(r.s);
          const projectBytes = () =>
            bytes(r.s).filter(
              ([path]) =>
                typeof path === "string" && path.startsWith("project"),
            );
          const files = projectBytes();
          const context = holding(
            r,
            variant === "caller generation"
              ? { leaseGeneration: 99 }
              : name === "Still refused"
                ? { leaseGeneration: grant.generation }
                : {},
          );
          if (variant === "pending actor")
            context.actor = { kind: "agent", id: "other" };
          if (variant === "pending session") context.session = { id: "other" };
          if (variant === "stopped")
            expect(
              (
                await r.assembly.catalog.invoke(
                  r.request("lane.stop", { id: ISSUE.id }, { context }),
                )
              ).ok,
            ).toBe(true);
          const expected =
            name === "Still refused"
              ? "INPUT_INVALID"
              : name === "Release with no attachment"
                ? "NOT_FOUND"
                : name === "Release of another generation" ||
                    variant === "replacement"
                  ? "LEASE_STALE"
                  : name === "Release by another holder"
                    ? "LEASE_NOT_HELD"
                    : [
                          "still held",
                          "read unavailable",
                          "retry",
                          "delayed original request",
                        ].includes(variant)
                      ? "UNAVAILABLE"
                      : "OK";
          const input =
            variant === "lane.close"
              ? { id: ISSUE.id, noPr: true, dropped: "stopped" }
              : { id: ISSUE.id };
          const result = await r.assembly.catalog.invoke(
            r.request(
              name === "Still refused" ? variant : "lane.release",
              input,
              { context, requestId: "release-original" },
            ),
          );
          expect(result.ok ? "OK" : result.error.code).toBe(expected);
          expect(exitCode(result)).toBe(
            expected === "OK"
              ? 0
              : expected === "INPUT_INVALID"
                ? 6
                : expected === "NOT_FOUND"
                  ? 3
                  : expected === "UNAVAILABLE"
                    ? 1
                    : 4,
          );
          expect(projectBytes()).toEqual(files);
          expect(existsSync(join(r.s.root, ".forge", "state.sqlite"))).toBe(
            false,
          );
          expect(issue).toEqual({ ...ISSUE, body: "retained cloud body" });
          expect(stopped).toBe(variant === "stopped");
          if (expected !== "OK") {
            if (!releases) expect(attachmentBytes(r.s)).toEqual(before);
            else
              expect(await inspect()).toEqual({
                ...attached,
                releaseRequestId: releaseIds[0],
              });
          }
          if (variant === "still held") {
            const pending = attachmentBytes(r.s);
            const restart = await r.assembly.catalog.invoke(
              r.request(
                "lane.start",
                {
                  id: ISSUE.id,
                  branch: "feat/one",
                  brief: "brief.md",
                },
                { context },
              ),
            );
            expect(failed(restart, "INPUT_CONFLICT")).toBe(4);
            expect(attachmentBytes(r.s)).toEqual(pending);
          }
          if (name !== "Lost release answer" && expected !== "OK")
            expect(releases).toBe(0);
          if (name === "Still refused") expect(r.net.calls).toHaveLength(0);
          if (
            expected === "OK" ||
            ["retry", "delayed original request"].includes(variant)
          ) {
            if (["retry", "delayed original request"].includes(variant)) {
              expect(releases).toBe(1);
              expect(
                (
                  await r.assembly.catalog.invoke(
                    r.request(
                      "lane.release",
                      { id: ISSUE.id },
                      {
                        context:
                          variant === "delayed original request"
                            ? {
                                ...context,
                                session: { id: "s1", harness: "changed" },
                              }
                            : context,
                        requestId: "release-retry",
                      },
                    ),
                  )
                ).ok,
              ).toBe(true);
            }
            const local = new LocalState(
              join(r.s.deviceRoot, "records.sqlite"),
            );
            try {
              const saved = (await local.open(false))!.get(
                "forge/work",
                journalKey(),
              )!;
              expect(saved.revision).toBe(3);
              expect(saved.value).not.toHaveProperty("releaseRequestId");
              expect(saved.value).toMatchObject({
                ...attached,
                active: false,
                releaseNeeded: false,
              });
            } finally {
              await local.close();
            }
            expect(releases).toBe(
              variant === "delayed original request" ? 2 : 1,
            );
            if (variant === "delayed original request") {
              expect(releaseIds).toEqual([releaseIds[0]!, releaseIds[0]!]);
              expect(principals).toEqual([grant.holder, grant.holder]);
              expect(effects).toBe(1);
            }
            if (name === "Lost release answer")
              expect(reads).toBeGreaterThanOrEqual(2);
            if (variant === "accepted") {
              before = attachmentBytes(r.s);
              expect(
                (
                  await r.assembly.catalog.invoke(
                    r.request(
                      "lane.release",
                      { id: ISSUE.id },
                      { context, requestId: "release-again" },
                    ),
                  )
                ).ok,
              ).toBe(true);
              expect(releases).toBe(1);
              expect(attachmentBytes(r.s)).toEqual(before);
            }
          }
        },
      );
    }
  }, 60000);

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

// A schema-valid success answer that carries the presented token is refused, never printed.
const NOT_USABLE = "The Forge cloud gave no usable answer.";
const ECHO = `before-${TOKEN}-after`;

test("through the CLI wrapper, an issue show whose title carries the presented token is the fixed UNAVAILABLE, with the token in neither the envelope nor stdout", () =>
  using({ steps: [() => answer({ ...ISSUE, title: ECHO })] }, async (r) => {
    const done = await runCli(
      r.assembly.catalog,
      ["issue", "show", "forge-1"],
      { caller: "agent", context: holding(r) },
    );
    expect(errorOf(done)).toMatchObject({
      code: "UNAVAILABLE",
      message: NOT_USABLE,
    });
    for (const shown of [JSON.stringify(done.envelope), done.stdout])
      expect(shown).not.toMatch(/fct_|before-/);
    expect(done.exitCode).toBe(1);
    expect(r.net.calls).toHaveLength(1);
  }));

test("a cloud issue.list item with the token in one label is refused as UNAVAILABLE", () =>
  using(
    {
      steps: [
        () =>
          answer(
            { items: [{ ...ISSUE, labels: ["a", ECHO] }], truncated: false },
            "issue.list",
          ),
      ],
    },
    async (r) => {
      const result = await r.assembly.catalog.invoke(
        r.request("issue.list", {}),
      );
      expect(failed(result, "UNAVAILABLE")).toBe(1);
      expect(r.net.calls).toHaveLength(1);
    },
  ));

test("through the CLI wrapper, a schema-valid StateRecord whose free-form value carries the token in a url is the fixed UNAVAILABLE, with the token in neither the envelope nor stdout", () =>
  using(
    {
      steps: [
        () =>
          answer(
            {
              records: [
                {
                  ...RECORD,
                  value: { url: `https://example.com/?token=${TOKEN}` },
                },
              ],
            },
            "issue.comments",
          ),
      ],
    },
    async (r) => {
      const done = await runCli(
        r.assembly.catalog,
        ["issue", "comments", "forge-1"],
        { caller: "agent", context: holding(r) },
      );
      expect(errorOf(done)).toMatchObject({
        code: "UNAVAILABLE",
        message: NOT_USABLE,
      });
      for (const shown of [JSON.stringify(done.envelope), done.stdout])
        expect(shown).not.toMatch(/fct_|example\.com/);
      expect(done.exitCode).toBe(1);
      expect(r.net.calls).toHaveLength(1);
    },
  ));

test("a schema-valid StateRecord whose free-form value carries the token only as a property name is the fixed UNAVAILABLE through the CLI wrapper and MCP catalog_call, with the token in no output", () =>
  using(
    {
      steps: [
        () =>
          answer(
            { records: [{ ...RECORD, value: { [TOKEN]: "x" } }] },
            "issue.comments",
          ),
      ],
    },
    async (r) => {
      const done = await runCli(
        r.assembly.catalog,
        ["issue", "comments", "forge-1"],
        { caller: "agent", context: holding(r) },
      );
      expect(errorOf(done)).toMatchObject({
        code: "UNAVAILABLE",
        message: NOT_USABLE,
      });
      for (const shown of [JSON.stringify(done.envelope), done.stdout])
        expect(shown).not.toContain(TOKEN);
      expect(done.exitCode).toBe(1);
      const handlers = createMcpHandlers(
        r.assembly.catalog,
        { expose: ["issue"] },
        { context: holding(r) },
      );
      const mcp = await handlers.callTool("catalog_call", {
        op: "issue.comments",
        input: NOTES,
      });
      expect(mcp).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: NOT_USABLE },
      });
      expect(failed(mcp!, "UNAVAILABLE")).toBe(1);
      expect(r.net.calls).toHaveLength(2);
    },
  ));

for (const [name, value] of [
  ["a value", { url: `https://example.com/?token=${TOKEN}` }],
  ["a property name", { [TOKEN]: "x" }],
] as const)
  test(`through the CLI wrapper, a schema-valid links result carrying the presented token in ${name} is the fixed UNAVAILABLE, with the token in neither the envelope nor stdout`, () =>
    using(
      {
        steps: [
          () => answer({ records: [{ ...LINK_RECORD, value }] }, "issue.links"),
        ],
      },
      async (r) => {
        const done = await runCli(
          r.assembly.catalog,
          ["issue", "links", "forge-1"],
          { caller: "agent", context: holding(r) },
        );
        expect(errorOf(done)).toMatchObject({
          code: "UNAVAILABLE",
          message: NOT_USABLE,
        });
        for (const shown of [JSON.stringify(done.envelope), done.stdout])
          expect(shown).not.toMatch(/fct_|example\.com/);
        expect(done.exitCode).toBe(1);
        expect(r.net.calls).toHaveLength(1);
      },
    ));

test("a cloud issue.update result with the token in its body is refused as UNAVAILABLE after one update request", () =>
  using(
    {
      steps: [live, () => answer({ ...UPDATED, body: ECHO }, "issue.update")],
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
  ["issue.links", NOTES],
  ["issue.list", {}],
  ["issue.ready", {}],
  ["issue.blocked", {}],
  ["issue.stale", {}],
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
const VERIFIED_CLOSE = { id: "forge-1", pr: 490 };
const verifiedClosed = { ...CLOSED, receipt: "verified-1" };

for (const [code, status, wrongStatus, message, localMessage] of [
  [
    "RECEIPT_INVALID",
    400,
    200,
    "Missing or unapproved workflow evidence",
    "The Forge cloud could not accept the receipt evidence.",
  ],
  [
    "RECEIPT_HEAD_MISMATCH",
    409,
    400,
    "Workflow must cover merge commit",
    "The receipt evidence must cover the merge commit.",
  ],
  [
    "PR_NOT_MERGED",
    409,
    200,
    "PR has not landed on target",
    "The pull request has not merged into its target branch.",
  ],
] as const)
  for (const [op, httpStatus, expectedCode, expectedMessage] of [
    ["close", status, code, localMessage],
    ["close", wrongStatus, "UNAVAILABLE", NOT_USABLE],
    ["show", status, "UNAVAILABLE", NOT_USABLE],
  ] as const)
    test(`CLI issue ${op} reports ${expectedCode} for ${code} at HTTP ${httpStatus}`, () =>
      using(
        {
          steps: [
            () =>
              fx.json(
                {
                  ok: false,
                  status: "FAIL",
                  error: { code, message, retry: "never" },
                  warnings: [],
                },
                httpStatus,
              ),
          ],
        },
        async (r) => {
          const prArgs = op === "close" ? ["--pr", "490"] : [];
          const done = await runCli(
            r.assembly.catalog,
            ["issue", op, "forge-1", ...prArgs],
            {
              caller: "agent",
              context: holding(r, op === "close" ? { leaseGeneration: 3 } : {}),
            },
          );
          expect(done.envelope).toMatchObject({
            ok: false,
            status: "FAIL",
            error: { code: expectedCode, message: expectedMessage },
          });
          expect(done.exitCode).toBe(1);
          expect(sent(r)).toEqual([`issue.${op}`]);
        },
      ));

for (const surface of ["CLI", "MCP", "catalog"] as const)
  for (const [name, authority, extra, flags, code, exit, requests] of [
    ["verified", "bound", {}, [], undefined, 0, 1],
    ["not merged", "bound", {}, [], "UNAVAILABLE", 1, 1],
    [
      "with receipt",
      "bound",
      { receipt: "local-1" },
      ["--receipt", "local-1"],
      "INPUT_INVALID",
      6,
      0,
    ],
    [
      "with exemption",
      "bound",
      { withoutReceipt: "manual" },
      ["--without-receipt", "manual"],
      "INPUT_INVALID",
      6,
      0,
    ],
    ["unbound", "unbound", {}, [], "INPUT_INVALID", 6, 0],
    [
      "half-bound with receipt",
      "half-bound",
      { receipt: "local-1" },
      ["--receipt", "local-1"],
      "INPUT_CONFLICT",
      4,
      0,
    ],
    [
      "half-bound with exemption",
      "half-bound",
      { withoutReceipt: "manual" },
      ["--without-receipt", "manual"],
      "INPUT_CONFLICT",
      4,
      0,
    ],
  ] as const)
    test(
      `${surface} verified close: ${name}`,
      () =>
        using(
          {
            bind: authority === "bound" ? {} : false,
            creds: authority === "unbound" ? false : {},
            steps: [
              () =>
                code === "UNAVAILABLE"
                  ? refusing(code)
                  : answer(verifiedClosed, "issue.close"),
            ],
          },
          async (r) => {
            const input = { ...VERIFIED_CLOSE, ...extra };
            const context = holding(
              r,
              requests === 0 ? {} : { leaseGeneration: 3 },
            );
            const result =
              surface === "CLI"
                ? (
                    await runCli(
                      r.assembly.catalog,
                      ["issue", "close", "forge-1", "--pr", "490", ...flags],
                      { caller: "agent", context },
                    )
                  ).envelope
                : surface === "MCP"
                  ? (await createMcpHandlers(
                      r.assembly.catalog,
                      { expose: ["issue"] },
                      { context },
                    ).callTool("issue_close", input))!
                  : await r.assembly.catalog.invoke(
                      r.request("issue.close", input, { context }),
                    );
            expect(result).toMatchObject(
              code === undefined
                ? { ok: true, status: "OK", result: verifiedClosed }
                : { ok: false, status: "FAIL", error: { code } },
            );
            expect(exitCode(result)).toBe(exit);
            if (authority === "half-bound")
              expect(result).toMatchObject({
                error: {
                  message:
                    "This project has a saved cloud credential but no .forge/cloud.json; run forge auth login again",
                },
              });
            expect(r.net.calls).toHaveLength(requests);
            if (requests > 0)
              expect(r.net.calls[0]!.body).toMatchObject({
                op: "issue.close",
                input,
                context: { leaseGeneration: 3 },
              });
          },
        ),
      30_000,
    );

for (const surface of ["CLI", "MCP"] as const)
  for (const verb of ["admit", "show"])
    test(
      `${surface} receipt.${verb} is UNKNOWN_COMMAND and not exposed`,
      () =>
        using({}, async (r) => {
          const handlers = createMcpHandlers(r.assembly.catalog, {
            expose: ["receipt"],
          });
          expect(
            handlers
              .listTools()
              .some((tool) => tool.name === `receipt_${verb}`),
          ).toBe(false);
          const result =
            surface === "CLI"
              ? (
                  await runCli(r.assembly.catalog, [
                    "receipt",
                    verb,
                    "--input",
                    "{}",
                  ])
                ).envelope
              : (await handlers.callTool("catalog_call", {
                  op: `receipt.${verb}`,
                  input: {},
                }))!;
          expect(result).toMatchObject({
            ok: false,
            status: "FAIL",
            error: { code: "UNKNOWN_COMMAND" },
          });
          expect(exitCode(result)).toBe(3);
          expect(r.net.calls).toHaveLength(0);
        }),
      30_000,
    );

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
  test(`${noun}.claim for ${ids.join(", ")} lost to another holder shows fixed text and the full lease in --json and --text, with exit 4 and no local state`, () =>
    using(
      {
        config: source,
        steps: [() => refusing("LEASE_HELD", { lease: heldBy("0007") })],
      },
      async (r) => {
        const want = {
          ...localRefusal(heldBy("0007"), 0),
          message:
            "Another holder has the lease. Read the lease state to reconcile before retrying.",
        };
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
    for (const op of LISTS)
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
    expect(await call("issue.links", { id })).toMatchObject({
      ok: true,
      result: { records: [] },
    });
    const url = "https://example.com/pull/1";
    expect(
      await call("issue.link", { id, relation: "delivers", url }),
    ).toMatchObject({ ok: true });
    expect(await call("issue.links", { id })).toMatchObject({
      ok: true,
      result: { records: [{ value: { relation: "delivers", url } }] },
    });
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

/** A preflight that hands the request to `accepted` as the real one does, then refuses with `thrown`. */
const preflightThrowing = (thrown: unknown) =>
  mock(
    (value: InvocationRequest, accepted?: (v: InvocationRequest) => void) => {
      accepted?.(value);
      throw thrown;
    },
  );
const selectFrom = (
  r: Awaited<ReturnType<typeof rig>>,
  runtime: { preflight: unknown; invoke?: unknown },
) =>
  selectCloud(
    {
      root: r.s.root,
      deviceRoot: r.s.deviceRoot,
      scope: () => {},
      env: { HOME: r.s.home, FORGE_DEVICE_ID: "dev-1" },
      cloud: { fetch: r.net.fetch, now: () => NOW },
    },
    runtime as never,
    r.request("issue.show", { id: "forge-1" }),
  );

test("a refused preflight on a bound project is the runtime's envelope, never retried on the local runtime", async () => {
  const refused = new ForgeFailure({
    code: "GRANT_REQUIRED",
    message: "no",
    retry: "never",
  });
  const preflight = preflightThrowing(refused);
  const invoke = mock();
  await using({}, async (r) => {
    expect(await selectFrom(r, { preflight, invoke })).toEqual({
      ok: false,
      op: "issue.show",
      status: "INCOMPLETE",
      error: refused.error,
      warnings: [],
    });
    expect([preflight.mock.calls.length, invoke.mock.calls.length]).toEqual([
      1, 0,
    ]);
    expect(r.net.calls).toHaveLength(0);
  });
  await using({ bind: false, creds: false }, async (r) => {
    expect(await selectFrom(r, { preflight, invoke })).toBeUndefined();
  });
});

/** The runtime maps these preflight refusals to INCOMPLETE. No real preflight reaches the limit and process ones, so the mapping is pinned here with a preflight that throws them. */
const INCOMPLETE_CODES = [
  "ADMISSION_REQUIRED",
  "GRANT_REQUIRED",
  "LIMIT_EXCEEDED",
  "CONTAINMENT_UNAVAILABLE",
  "PROCESS_LIMIT_EXCEEDED",
  "PROVIDER_MISSING",
] as const;
for (const [code, retry, status, kept] of [
  ...INCOMPLETE_CODES.map((c) => [c, "never", "INCOMPLETE", "never"] as const),
  ["INPUT_INVALID", "never", "FAIL", "never"],
  ["UNAVAILABLE", "reconcile_first", "FAIL", "reconcile_first"],
  // A refusal has not started, so a timeout is never retried; every other code keeps its own retry.
  ["INVOCATION_TIMEOUT", "reconcile_first", "FAIL", "never"],
] as const)
  test(`a bound project's preflight ${code} with retry ${retry} is the runtime's ${status} envelope with retry ${kept}`, () =>
    using({}, async (r) => {
      const failure = { code, message: "refused", retry } as const;
      const preflight = preflightThrowing(new ForgeFailure(failure));
      expect(await selectFrom(r, { preflight })).toEqual({
        ok: false,
        op: "issue.show",
        status,
        error: { ...failure, retry: kept },
        warnings: [],
      });
      expect(r.net.calls).toHaveLength(0);
    }));

test("a bound project's preflight that throws something other than a refusal is the runtime's BLOCK_EXECUTION_FAILED envelope", () =>
  using({}, async (r) => {
    const preflight = preflightThrowing(new Error("boom"));
    expect(await selectFrom(r, { preflight })).toMatchObject({
      ok: false,
      op: "issue.show",
      status: "FAIL",
      error: { code: "BLOCK_EXECUTION_FAILED", retry: "never" },
      warnings: [],
    });
    expect(r.net.calls).toHaveLength(0);
  }));

const BOTH = JSON.stringify({
  schemaVersion: "forge.config/1",
  blocks: {
    work: { source: { builtin: "forge/work" } },
    cloud: { source: { builtin: "forge/cloud" } },
  },
});
/** What one real call saw: its envelope, and how often the runtime checked a request and ran one. */
interface Refused {
  envelope: ResultEnvelope;
  preflights: number;
  invokes: number;
  requests: number;
}
/** One call through the real assembly on a bound or an unbound project, under spies that call through. */
async function refusedOn(
  bound: boolean,
  call: (r: Rig) => Promise<ResultEnvelope>,
): Promise<Refused> {
  const preflight = spyOn(Runtime.prototype, "preflight");
  const invoke = spyOn(Runtime.prototype, "invoke");
  let seen: Refused | undefined;
  try {
    await using(
      bound
        ? { config: BOTH }
        : { config: BOTH, bind: false, creds: false, sentinel: false },
      async (r) => {
        const envelope = await call(r);
        seen = {
          envelope,
          preflights: preflight.mock.calls.length,
          invokes: invoke.mock.calls.length,
          requests: r.net.calls.length,
        };
      },
    );
  } finally {
    preflight.mockRestore();
    invoke.mockRestore();
  }
  return seen!;
}
/** The bound call took the bound path (the request was checked once and the local runtime never ran); the unbound one reached the local runtime (and was checked again there). */
const tookPaths = (bound: Refused, unbound: Refused) => {
  expect([bound.preflights, bound.invokes, bound.requests]).toEqual([1, 0, 0]);
  expect([unbound.preflights, unbound.invokes]).toEqual([2, 1]);
};

for (const [name, op, input, change, code, status, exit] of [
  [
    "a caller the operation does not allow, in another block",
    "cloud.login",
    {},
    { caller: "agent" },
    "GRANT_REQUIRED",
    "INCOMPLETE",
    2,
  ],
  [
    "an input the schema refuses",
    "issue.show",
    { id: 5 },
    {},
    "INPUT_INVALID",
    "FAIL",
    6,
  ],
  [
    "a dry run of another block's operation",
    "cloud.login",
    {},
    { caller: "human", dryRun: true },
    "UNAVAILABLE",
    "FAIL",
    1,
  ],
] as [
  string,
  string,
  object,
  Partial<InvocationRequest>,
  string,
  string,
  number,
][])
  test(`a preflight refusal for ${name} is the same envelope on a bound project as on an unbound one, with no cloud request`, async () => {
    const run = (r: Rig) =>
      r.assembly.catalog.invoke(r.request(op, input, change));
    const bound = await refusedOn(true, run);
    const unbound = await refusedOn(false, run);
    expect(unbound.envelope).toMatchObject({
      ok: false,
      status,
      error: { code },
    });
    expect(exitCode(unbound.envelope)).toBe(exit);
    expect(bound.envelope).toEqual(unbound.envelope);
    tookPaths(bound, unbound);
  }, 60_000);

for (const surface of ["CLI", "MCP"] as const)
  test(`through ${surface}, a preflight refusal on a bound project renders the same status and exit as on an unbound one`, async () => {
    const input = { id: 5 };
    const run = async (r: Rig) => {
      const context = holding(r);
      if (surface === "CLI")
        return (
          await runCli(
            r.assembly.catalog,
            ["issue", "show", "--input", JSON.stringify(input)],
            { caller: "agent", context },
          )
        ).envelope;
      const mcp = createMcpHandlers(
        r.assembly.catalog,
        { expose: ["issue"] },
        { context },
      );
      return (await mcp.callTool("catalog_call", {
        op: "issue.show",
        input,
      }))!;
    };
    const bound = await refusedOn(true, run);
    const unbound = await refusedOn(false, run);
    expect(unbound.envelope).toMatchObject({
      ok: false,
      status: "FAIL",
      error: { code: "INPUT_INVALID" },
    });
    expect(bound.envelope).toEqual(unbound.envelope);
    expect(exitCode(bound.envelope)).toBe(6);
    expect(exitCode(unbound.envelope)).toBe(6);
    expect([bound.invokes, bound.requests]).toEqual([0, 0]);
    expect(unbound.invokes).toBe(1);
  }, 60_000);

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

const PIN_REPLIES = [undefined, "INPUT_CONFLICT", "INPUT_INVALID"] as const;
const pinReply = (code?: string) =>
  code ? refusing(code) : answer(COMMENTED, "issue.comment");
test("every public pinning path keeps the cloud id and refusal mapping; ordinary CLI ids stay fresh", async () => {
  const steps = [
    ...Array.from({ length: 6 }, () => PIN_REPLIES).flat(),
    undefined,
    undefined,
  ].map((code) => () => pinReply(code));
  await using({ steps }, async (r) => {
    const catalog = r.assembly.catalog,
      context = holding(r);
    const options = { caller: "agent" as const, context, requestId: "x" };
    const call = { op: "issue.comment", input: COMMENT, requestId: "x" };
    const mcp = createMcpHandlers(
      catalog,
      { expose: ["issue.comment"] },
      options,
    );
    const cli = ["catalog", "call", "--input", JSON.stringify(call)];
    const paths = [
      () => dispatch(catalog, "catalog.call", call, options),
      () => dispatch(catalog, call.op, call.input, options),
      () => mcp.callTool("catalog_call", call),
      () => mcp.callTool("issue_comment", call.input),
      async () => (await runCli(catalog, cli, options)).envelope,
      () => catalog.invoke(r.request(call.op, call.input, { requestId: "x" })),
    ];
    for (const run of paths)
      for (const [code, exit] of [
        [undefined, 0],
        ["INPUT_CONFLICT", 4],
        ["INPUT_INVALID", 6],
      ] as const) {
        const count = r.net.calls.length,
          result = await run();
        expect(result).toBeDefined();
        expect(exitCode(result!)).toBe(exit);
        expect(result).toMatchObject(
          code
            ? { ok: false, error: { code } }
            : { ok: true, result: COMMENTED },
        );
        expect(wire(r).slice(count)).toEqual(["command"]);
        expect(r.net.calls.at(-1)!.body).toMatchObject(call);
      }
    const count = r.net.calls.length;
    for (const _ of [1, 2]) {
      const reply = await runCli(
        catalog,
        ["issue", "comment", "--input", JSON.stringify(COMMENT)],
        { caller: "agent", context },
      );
      expect(reply.exitCode).toBe(0);
    }
    const ids = r.net.calls
      .slice(count)
      .map((call) => (call.body as { requestId: string }).requestId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids)
      expect(id).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
      );
  });
}, 30_000);
const FENCE_MESSAGE =
  "This project is connected to Forge cloud. Local project-state writes are unavailable because this block has no cloud version.";
const FENCE_REPAIR =
  "Use cloud-served forge issue commands for issue work. For device-only notes, use memory.add with level=device; block authors must declare context=device and use device state. Other project-state writes must wait until their blocks have cloud versions (forge-1345). Do not run forge store reinit or remove the cloud binding to bypass this refusal.";
const acceptance = [
  "Bound native check writer",
  "Bound decision writers",
  "Custom project writer",
  "All state mutation families",
  "Writable cache hit / promotion",
  "Bound project memory",
  "Bound cross-level moves",
  "Explicit device memory",
  "Explicit custom device state",
  "Device declaration with project capability",
  "Bound reads",
  "Undeclared write",
  "Bound registered missing read",
  "Bound unregistered missing read",
  "Unbound registered missing read/write",
  "Unbound writers and reads",
  "Existing unsupported work / reinit",
  "Invalid authority binding",
  "Missing bound manifest",
]; // The twentieth row (all sixteen served operations) extends the existing route matrix above.
test.each(acceptance)(
  "project-state fence: %s",
  async (name) => {
    const config = JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        work: { source: { builtin: "forge/work" } },
        memory: {
          source: { builtin: "forge/memory" },
          config: {
            levels: { human: "nearest", agent: "nearest" },
            decisions: { idPattern: "D-N" },
          },
        },
        check: {
          source: { builtin: "forge/check" },
          config: {
            commands: {
              test: {
                argv: [
                  process.execPath,
                  "-e",
                  "require('node:fs').writeFileSync('command-marker','ran')",
                ],
              },
            },
            report: "exit-code",
          },
        },
        renamed: {
          source: { path: "./probe" },
          rename: { probe: "renamed" },
        },
      },
    });
    await using(
      {
        config,
        bind: false,
        creds: false,
        sentinel: false,
        prepare: (s) => {
          cpSync(join(staging, "probe"), join(s.root, "probe"), {
            recursive: true,
          });
          addWorktree(s);
        },
      },
      async (r) => {
        let assembly = r.assembly,
          sequence = 0;
        const call = (
          op: string,
          input: object = {},
        ): Promise<ResultEnvelope> =>
          assembly.catalog.invoke({
            ...r.request(op, input, {
              caller: "human",
              context: holding(r, { actor: human, leaseGeneration: 1 }),
            }),
            requestId: `fence-${++sequence}`,
          });
        const { digest } = done(
          await call("block.check", { path: "./probe" }),
        ) as { digest: string };
        done(await relay(call, "block.admit", { digest }));
        done(
          await relay(call, "config.grant", {
            digest,
            effects: ["probe:write"],
          }),
        );
        const device = done(
          await call("memory.add", {
            text: "device",
            level: "device",
            scope: "project",
          }),
        ) as { id: string };
        const project = done(
          await call("memory.add", { text: "project", level: "project" }),
        ) as { id: string };
        const decision = done(
          await call("decision.propose", { title: "seed", text: "evidence" }),
        ) as { id: string };
        const receipt = done(await call("check.run", { checks: ["test"] })) as {
          id: string;
          status: string;
        };
        expect(receipt.status).toBe("PASS");
        done(await call("renamed.put"));
        done(await call("renamed.acquire"));
        const bind = () =>
          writeFileSync(r.s.binding, JSON.stringify(fx.bindingFor()));
        bind();
        const snapshot = (allow: string[]) => [
          Object.fromEntries(
            Object.entries(inventory(r.s.dir)).filter(
              ([path]) => !allow.some((part) => path.includes(part)),
            ),
          ),
          r.net.calls.length,
        ];
        const check = async (
          op: string,
          input: object = {},
          code = "UNAVAILABLE",
          allow: string[] = [],
          message?: string,
          surface = "direct",
        ) => {
          const before = snapshot(allow),
            context = localContext(assembly, human);
          const result =
            surface === "MCP"
              ? (await createMcpHandlers(
                  assembly.catalog,
                  { expose: [op] },
                  { context },
                ).callTool("catalog_call", { op, input }))!
              : surface.startsWith("CLI")
                ? (
                    await runCli(
                      assembly.catalog,
                      [
                        ...op.split("."),
                        "--input",
                        JSON.stringify(input),
                        ...(surface === "CLI text" ? ["--text"] : []),
                      ],
                      { caller: "human", context },
                    )
                  ).envelope
                : op === "decision.adopt" || op === "memory.restore"
                  ? await relay(call, op, {
                      ...input,
                      approval: { by: "owner", quote: "yes" },
                    })
                  : await call(op, input);
          expect(result).toMatchObject(
            code === "OK"
              ? { ok: true, status: "OK" }
              : {
                  ok: false,
                  status: code === "GRANT_REQUIRED" ? "INCOMPLETE" : "FAIL",
                  error: {
                    code,
                    retry:
                      code === "GRANT_REQUIRED" ||
                      (code === "UNAVAILABLE" &&
                        !message &&
                        (op.startsWith("memory.") || op === "renamed.escalate"))
                        ? "reconcile_first"
                        : "never",
                    ...(message ? { message } : {}),
                  },
                },
          );
          const exits: Record<string, number> = {
            OK: 0,
            GRANT_REQUIRED: 2,
            INPUT_CONFLICT: 4,
            INPUT_INVALID: 6,
            CONTEXT_MISSING: 6,
          };
          expect(exitCode(result)).toBe(exits[code] ?? 1);
          if (code === "UNAVAILABLE" && !message)
            expect(result).toMatchObject({
              error: { message: FENCE_MESSAGE, repair: FENCE_REPAIR },
            });
          expect(snapshot(allow)).toEqual(before);
        };
        const reset = async (drop = false) => {
          await assembly.close();
          if (drop) rmSync(STORE(r.s));
          assembly = await r.open();
        };
        const missing = (bound: boolean) =>
          bound
            ? `Missing local Forge store at ${STORE(r.s)}. This project is cloud-bound; forge store reinit is disabled. Use cloud-served forge issue commands for shared issue state. To inspect historical local-only records, restore a backup; unsupported project-state writes remain disabled.`
            : `Missing Forge store at ${STORE(r.s)}. Fix: restore it from a backup, or run forge store reinit to start a new empty store.`;
        const launchSpy = spyOn(launch, "runProcess");
        try {
          switch (name) {
            case "Bound native check writer":
              for (const absent of [false, true]) {
                if (absent) await reset(true);
                await check("check.run", { checks: ["test"] });
              }
              expect(
                launchSpy.mock.calls.filter(([, args]) =>
                  args.some((arg) => arg.includes("command-marker")),
                ),
              ).toEqual([]);
              break;
            case "Bound decision writers":
              await check("decision.propose", {
                title: "decision",
                text: "evidence",
              });
              await check(
                "decision.adopt",
                { id: decision.id },
                "UNAVAILABLE",
                ["trust.sqlite"],
              );
              break;
            case "Custom project writer":
              for (const absent of [false, true]) {
                if (absent) await reset(true);
                for (const surface of ["direct", "CLI JSON", "CLI text", "MCP"])
                  await check(
                    "renamed.put",
                    { revision: absent ? 0 : 1 },
                    "UNAVAILABLE",
                    [],
                    undefined,
                    surface,
                  );
                await check("renamed.acquire");
              }
              break;
            case "All state mutation families":
              for (const verb of PROBE_MUTATIONS)
                await check(`renamed.${verb}`, { revision: 1 });
              break;
            case "Writable cache hit / promotion": {
              rmSync(r.s.binding);
              const acquire = Object.getOwnPropertyDescriptor(
                LocalState.prototype,
                "acquire",
              )!.value as LocalState["acquire"];
              const keep = spyOn(
                LocalState.prototype,
                "acquire",
              ).mockImplementation(async function (this: LocalState, write) {
                const lease = await acquire.call(this, write);
                await this.open(write);
                return lease;
              });
              try {
                done(await call("renamed.put", { revision: 1 }));
                bind();
                await check("renamed.put", { revision: 2 });
                await reset();
                done(await call("renamed.read"));
                await check("renamed.put", { revision: 2 });
              } finally {
                keep.mockRestore();
              }
              await reset();
              const fault = spyOn(authority, "cloudBinding").mockReturnValue({
                kind: "unbound",
              });
              try {
                done(await call("renamed.put", { revision: 2 }));
              } finally {
                fault.mockRestore();
              }
              break;
            }
            case "Bound project memory":
              for (const input of [
                { text: "project", level: "project" },
                { text: "nearest" },
                { id: project.id, expectRevision: 1, text: "edit" },
              ])
                await check("memory.add", input);
              await check(
                "memory.restore",
                {
                  format: "forge.memory.export/3",
                  level: "project",
                  notes: [],
                },
                "UNAVAILABLE",
                ["trust.sqlite"],
              );
              break;
            case "Bound cross-level moves":
              for (const [id, to] of [
                [device.id, "project"],
                [project.id, "device"],
              ])
                await check("memory.move", { id, expectRevision: 1, to });
              await check("memory.move", { scope: "project", to: "project" });
              break;
            case "Explicit device memory":
              await check(
                "memory.add",
                { text: "device only", level: "device" },
                "OK",
                ["records.sqlite"],
              );
              await check("memory.propose-forget", { id: device.id }, "OK", [
                "records.sqlite",
              ]);
              break;
            case "Explicit custom device state":
              await check("renamed.device", {}, "OK", ["records.sqlite"]);
              break;
            case "Device declaration with project capability":
              await check("renamed.escalate", { revision: 1 });
              break;
            case "Bound reads":
              for (const op of ["check.list", "decision.list", "renamed.read"])
                await check(op, {}, "OK");
              await check("check.show", { id: receipt.id }, "OK");
              break;
            case "Undeclared write":
              await check("renamed.sneak", { revision: 1 }, "GRANT_REQUIRED");
              break;
            case "Bound registered missing read":
              await reset(true);
              await check("renamed.read", {}, "UNAVAILABLE", [], missing(true));
              await check("renamed.put");
              break;
            case "Bound unregistered missing read":
              await reset(true);
              await assembly.close();
              rmSync(join(r.s.deviceRoot, "records.sqlite"));
              assembly = await r.open();
              await check("renamed.read", {}, "OK");
              break;
            case "Unbound registered missing read/write":
              rmSync(r.s.binding);
              await reset(true);
              for (const op of ["renamed.read", "renamed.put"])
                await check(op, {}, "UNAVAILABLE", [], missing(false));
              break;
            case "Unbound writers and reads":
              rmSync(r.s.binding);
              for (const [op, input] of [
                ["check.run", { checks: ["test"] }],
                ["decision.propose", { title: "local", text: "evidence" }],
                ["renamed.put", { revision: 1 }],
                ["renamed.device", {}],
                ["memory.add", { text: "project two", level: "project" }],
                ["memory.add", { text: "device two", level: "device" }],
              ] as const)
                await check(op, input, "OK", [
                  "state.sqlite",
                  "records.sqlite",
                  "command-marker",
                ]);
              for (const op of ["check.list", "decision.list", "renamed.read"])
                await check(op, {}, "OK");
              break;
            case "Existing unsupported work / reinit":
              for (const op of [...DECLARED, RECOVER]) {
                const entry = assembly.catalog
                  .list()
                  .concat(discoveryOperations)
                  .find((entry) => entry.op === op)!;
                expect(entry, op).toBeDefined();
                const input =
                  INPUTS[op] ??
                  entry.docs.examples?.[0]?.input ??
                  Object.fromEntries(
                    Object.entries({
                      ...COMMENT,
                      ...CLOSE,
                      session: "s2",
                      count: 1,
                      attempt: "attempt-1",
                      sha: "a".repeat(40),
                    }).filter(
                      ([key]) =>
                        key in (entry.argumentSchema!.properties as object),
                    ),
                  );
                for (const surface of ["direct", "CLI JSON"]) {
                  if (
                    (op === "lane.resume" || op === "lane.unfreeze") &&
                    surface === "direct"
                  ) {
                    const trust = new LocalState(
                      join(r.s.deviceRoot, "trust.sqlite"),
                    );
                    try {
                      const owner = (await trust.open(false))!,
                        prior = owner.export(),
                        filesBefore = snapshot(["trust.sqlite"]);
                      const approval = approvalReply(await call(op, input));
                      expect(
                        owner.get("forge/core-approvals", approval.request),
                      ).toMatchObject({
                        revision: 1,
                        value: { status: "pending" },
                      });
                      await check(
                        op,
                        { ...input, approval },
                        "INPUT_INVALID",
                        ["trust.sqlite"],
                        notServed(op),
                      );
                      expect(
                        owner.get("forge/core-approvals", approval.request),
                      ).toMatchObject({
                        revision: 2,
                        value: { status: "used", method: "relayed" },
                      });
                      const after = owner.export();
                      expect(after).toEqual({
                        ...prior,
                        image: after.image,
                        eventHighWaterMark: prior.eventHighWaterMark + 2,
                        records: after.records,
                        events: after.events,
                      });
                      for (const record of prior.records)
                        expect(after.records).toContainEqual(record);
                      for (const event of prior.events)
                        expect(after.events).toContainEqual(event);
                      expect([
                        after.records.length,
                        after.events.length,
                      ]).toEqual([
                        prior.records.length + 1,
                        prior.events.length + 2,
                      ]);
                      expect(after.events.slice(-2)).toMatchObject(
                        [1, 2].map((revision) => ({
                          namespace: "forge/core-approvals",
                          key: approval.request,
                          revision,
                        })),
                      );
                      expect(snapshot(["trust.sqlite"])).toEqual(filesBefore);
                    } finally {
                      await trust.close();
                    }
                    continue;
                  }
                  await check(
                    op,
                    input,
                    "INPUT_INVALID",
                    [],
                    notServed(op),
                    surface,
                  );
                }
              }
              break;
            case "Invalid authority binding":
              writeFileSync(r.s.binding, JSON.stringify(fx.bindingFor(other)));
              await check("renamed.put", {}, "INPUT_CONFLICT");
              break;
            case "Missing bound manifest":
              dropped(r.s);
              await check("renamed.put", {}, "CONTEXT_MISSING");
          }
        } finally {
          launchSpy.mockRestore();
          await assembly.close();
        }
      },
    );
  },
  120_000,
);

const PENDING_APPROVAL_MESSAGE =
  "Owner approval is still required. Run lane resume without an approval to get a new request.";
const SERVER_APPROVAL_MESSAGE =
  "Visit https://elsewhere.example.test/approve to approve";
const LANE_REQUEST = "00000000-0000-4000-8000-000000000008";
const LANE_APPROVAL = {
  request: LANE_REQUEST,
  scope: { id: "work-1" },
  expiresAt: iso(NOW + 60_000),
};
const LANE_CONTROL = { incarnation: "cloud-1", epoch: 2, stopped: true };
const laneRequired = (result: object = LANE_APPROVAL) =>
  fx.json(
    {
      ok: false,
      op: "lane.resume",
      status: "FAIL",
      error: {
        code: "APPROVAL_REQUIRED",
        message: "Fresh owner approval is required",
        retry: "never",
      },
      result,
      warnings: [],
    },
    409,
  );
const laneContext = (r: Rig) => r.request("lane.control", {}).context;

const chatChallenge = LANE_APPROVAL;
const chatRelay = {
  request: LANE_REQUEST,
  quote: " \tYes, resume this lane.\n",
  source: { harness: "test-chat", thread: "owner-thread", message: "reply-1" },
};
const relaySurfaces = ["CLI", "MCP direct", "MCP catalog"] as const;
type RelaySurface = (typeof relaySurfaces)[number];

async function runResume(
  r: Rig,
  surface: RelaySurface,
  input: object,
): Promise<ResultEnvelope> {
  const context = laneContext(r);
  if (surface === "CLI") {
    const cli = await runCli(
      r.assembly.catalog,
      ["lane", "resume", "--input", JSON.stringify(input)],
      { caller: "agent", context },
    );
    expect(cli.exitCode).toBe(exitCode(cli.envelope));
    expect(JSON.parse(cli.stdout)).toEqual(cli.envelope);
    return cli.envelope;
  }
  const mcp = createMcpHandlers(
    r.assembly.catalog,
    { expose: ["lane"] },
    { context },
  );
  return (await mcp.callTool(
    surface === "MCP direct" ? mcpToolName("lane.resume")! : "catalog_call",
    surface === "MCP direct" ? input : { op: "lane.resume", input },
  ))!;
}

for (const surface of relaySurfaces) {
  test.each([
    [{ all: true }, { all: true }, "all stopped lanes"],
    [{ id: "forge-1" }, { id: "work-1" }, "lane work-1"],
  ] as const)(
    `chat relay red 3: ${surface} shows the same local ask for %j`,
    (input, scope, target) =>
      using(
        { steps: [() => laneRequired({ ...chatChallenge, scope })] },
        async (r) => {
          const result = await runResume(r, surface, input);
          expect(exitCode(result)).toBe(1);
          expect(result).toMatchObject({
            ok: false,
            error: { code: "APPROVAL_REQUIRED" },
            result: {
              ...chatChallenge,
              scope,
              ask: `Resume ${target} in Forge project ${fx.PROJECT}? Forge can dispatch work and start spending calls and time again. Please reply here before 2026-11-11 00:01 UTC.`,
            },
          });
          expect(result).not.toHaveProperty("result.url");
          expect(r.net.calls).toHaveLength(1);
        },
      ),
    30_000,
  );

  test.each([
    { ...chatChallenge, scope: { id: "work-2" } },
    { ...chatChallenge, scope: { all: true } },
    { ...chatChallenge, ask: "Untrusted remote ask text" },
    { ...chatChallenge, expiresAt: iso(NOW - 1) },
  ])(
    `chat relay red 3: ${surface} refuses unchecked challenge %j`,
    (challenge) =>
      using({ steps: [() => laneRequired(challenge)] }, async (r) => {
        const result = await runResume(r, surface, { id: "forge-1" });
        expect(failed(result, "UNAVAILABLE")).toBe(1);
        expect(result).not.toHaveProperty("result");
        expect(r.net.calls).toHaveLength(1);
      }),
    30_000,
  );

  test(
    `chat relay red 3: ${surface} sends the reply verbatim to the cloud`,
    () =>
      using(
        { steps: [() => answer({ resumed: "work-1" }, "lane.resume")] },
        async (r) => {
          const input = { id: "forge-1", approval: chatRelay };
          const result = await runResume(r, surface, input);
          expect(r.net.calls).toHaveLength(1);
          expect(r.net.calls[0]!.body).toMatchObject({
            op: "lane.resume",
            input,
          });
          expect(result).toMatchObject({
            ok: true,
            result: { resumed: "work-1" },
          });
          expect(exitCode(result)).toBe(0);
        },
      ),
    30_000,
  );
}

const dispatchInput = {
  id: "work-1",
  dispatchId: "dispatch-proof",
  incarnation: LANE_CONTROL.incarnation,
  epoch: LANE_CONTROL.epoch,
};
const dispatchResult = {
  ...dispatchInput,
  holder: { device: "dev-1", session: "s1" },
  leaseGeneration: 2,
  recordedAt: iso(NOW),
  kind: "recorded-intent",
};

test.each(["CLI", "MCP"] as const)(
  "bound dispatch uses the cloud directly through %s without preparing a local lane",
  async (surface) =>
    using(
      { steps: [() => answer(dispatchResult, "lane.dispatch")] },
      async (r) => {
        const before = inventory(r.s.dir);
        const context = holding(r);
        const result =
          surface === "CLI"
            ? (
                await runCli(
                  r.assembly.catalog,
                  [
                    "lane",
                    "dispatch",
                    "--input",
                    JSON.stringify(dispatchInput),
                  ],
                  { caller: "agent", context },
                )
              ).envelope
            : await createMcpHandlers(
                r.assembly.catalog,
                { expose: ["lane"] },
                { context },
              ).callTool("lane_dispatch", dispatchInput);
        expect(result).toMatchObject({ ok: true, result: dispatchResult });
        expect(r.net.calls).toHaveLength(1);
        expect(r.net.calls[0]!.body).toMatchObject({
          op: "lane.dispatch",
          input: dispatchInput,
          context: { session: { id: "s1" } },
        });
        expect(r.net.calls[0]!.body).not.toHaveProperty(
          "context.leaseGeneration",
        );
        expect(inventory(r.s.dir)).toEqual(before);
      },
    ),
  30_000,
);

for (const mode of ["offline", "unbound", "dry run"] as const)
  test(
    `dispatch fails closed with ${mode} and leaves local state untouched`,
    () =>
      using(
        {
          ...(mode === "unbound"
            ? { bind: false, creds: false, sentinel: false }
            : {}),
          steps: [
            () => {
              throw new Error("offline");
            },
          ],
        },
        async (r) => {
          const before = inventory(r.s.dir);
          const result = await r.assembly.catalog.invoke(
            r.request("lane.dispatch", dispatchInput, {
              context: holding(r),
              dryRun: mode === "dry run",
            }),
          );
          expect(failed(result, "UNAVAILABLE")).toBe(1);
          expect(r.net.calls).toHaveLength(mode === "offline" ? 1 : 0);
          expect(inventory(r.s.dir)).toEqual(before);
        },
      ),
    30_000,
  );

for (const [name, op, input, result, dryRun] of [
  ["stop", "lane.stop", { id: "forge-1" }, LANE_CONTROL, false],
  ["stop all", "lane.stop", { all: true }, LANE_CONTROL, false],
  ["control", "lane.control", {}, LANE_CONTROL, false],
  [
    "control displayed id",
    "lane.control",
    { id: "forge-7" },
    LANE_CONTROL,
    false,
  ],
  [
    "approved resume",
    "lane.resume",
    { id: "forge-1", approval: chatRelay },
    { resumed: "work-1" },
    false,
  ],
  ["dry stop", "lane.stop", { all: true }, LANE_CONTROL, true],
] as const)
  test(
    `bound lane ${name} uses one cloud request without touching local state or approvals`,
    () =>
      using({ steps: [() => answer(result, op)] }, async (r) => {
        const before = inventory(r.s.dir);
        const resultEnvelope = await r.assembly.catalog.invoke(
          r.request(op, input, { dryRun }),
        );
        expect(resultEnvelope).toMatchObject({
          ok: true,
          status: "OK",
          result,
        });
        expect(exitCode(resultEnvelope)).toBe(0);
        expect(r.net.calls).toHaveLength(1);
        expect(r.net.calls[0]!.body).toMatchObject({
          op,
          input,
          ...(dryRun ? { dryRun: true } : {}),
        });
        expect(r.confirm).not.toHaveBeenCalled();
        expect(inventory(r.s.dir)).toEqual(before);
      }),
    30_000,
  );

for (const [surface, plain, message = SERVER_APPROVAL_MESSAGE] of [
  ["CLI", false],
  ["MCP catalog", false],
  ["MCP direct", false],
  ["CLI", true],
  ["MCP catalog", true],
  ["MCP direct", true],
  ["CLI", true, "Fresh approved owner authorization is required"],
] as const)
  test(
    `bound resume keeps the cloud approval ${plain ? "pending, denied or expired refusal without a link" : "request and link"} through ${surface}${message === SERVER_APPROVAL_MESSAGE ? "" : " with the Worker refusal"}`,
    () =>
      using(
        {
          steps: [
            () =>
              plain
                ? fx.json(
                    {
                      ok: false,
                      status: "FAIL",
                      warnings: [],
                      error: {
                        code: "APPROVAL_REQUIRED",
                        message,
                        retry: "never",
                      },
                    },
                    409,
                  )
                : laneRequired(),
          ],
        },
        async (r) => {
          const before = inventory(r.s.dir);
          const input = {
            id: "forge-1",
            ...(plain ? { approval: chatRelay } : {}),
          };
          const context = laneContext(r);
          let result: ResultEnvelope;
          if (surface === "CLI") {
            const cli = await runCli(
              r.assembly.catalog,
              plain
                ? ["lane", "resume", "--input", JSON.stringify(input)]
                : ["lane", "resume", "forge-1"],
              { caller: "agent", context },
            );
            expect(cli.exitCode).toBe(1);
            if (!plain) {
              expect(cli.stdout).toContain(LANE_REQUEST);
              expect(cli.stdout).toContain("Resume lane work-1");
            } else {
              expect(cli.stdout).toContain(PENDING_APPROVAL_MESSAGE);
              expect(cli.stdout).not.toContain(message);
            }
            result = cli.envelope;
          } else {
            const mcp = createMcpHandlers(
              r.assembly.catalog,
              { expose: ["lane"] },
              { context },
            );
            result = (await mcp.callTool(
              surface === "MCP direct"
                ? mcpToolName("lane.resume")!
                : "catalog_call",
              surface === "MCP direct" ? input : { op: "lane.resume", input },
            ))!;
          }
          expect(result).toMatchObject({
            ok: false,
            status: "FAIL",
            error: { code: "APPROVAL_REQUIRED" },
            ...(plain
              ? {
                  error: {
                    code: "APPROVAL_REQUIRED",
                    message: PENDING_APPROVAL_MESSAGE,
                  },
                }
              : {
                  result: {
                    ...LANE_APPROVAL,
                    ask: `Resume lane work-1 in Forge project ${fx.PROJECT}? Forge can dispatch work and start spending calls and time again. Please reply here before 2026-11-11 00:01 UTC.`,
                  },
                }),
          });
          if (plain) {
            expect(JSON.stringify(result)).not.toContain(message);
            expect(result).not.toHaveProperty("result");
            expect(JSON.stringify(result)).not.toContain("https://");
          }
          expect(exitCode(result)).toBe(1);
          expect(r.net.calls).toHaveLength(1);
          expect(r.confirm).not.toHaveBeenCalled();
          expect(inventory(r.s.dir)).toEqual(before);
        },
      ),
    30_000,
  );

for (const [name, op, input, dryRun, code, exit] of [
  [
    "quote alone",
    "lane.resume",
    { all: true, approval: { request: LANE_REQUEST, quote: "yes" } },
    false,
    "INPUT_INVALID",
    6,
  ],
  [
    "source alone",
    "lane.resume",
    {
      all: true,
      approval: {
        request: LANE_REQUEST,
        source: { harness: "fixture", thread: "fixture" },
      },
    },
    false,
    "INPUT_INVALID",
    6,
  ],
  ["dry resume", "lane.resume", { all: true }, true, "UNAVAILABLE", 1],
  ["dry control", "lane.control", {}, true, "UNAVAILABLE", 1],
  ["dry status", "lane.status", {}, true, "UNAVAILABLE", 1],
] as const)
  test(
    `bound lane ${name} is refused before HTTP and leaves local approvals unchanged`,
    () =>
      using({}, async (r) => {
        const before = inventory(r.s.dir);
        const result = await r.assembly.catalog.invoke(
          r.request(op, input, { dryRun }),
        );
        expect(failed(result, code)).toBe(exit);
        expect(r.net.calls).toHaveLength(0);
        expect(r.confirm).not.toHaveBeenCalled();
        expect(inventory(r.s.dir)).toEqual(before);
      }),
    30_000,
  );

for (const [name, result] of [
  [
    "another origin",
    {
      ...LANE_APPROVAL,
      url: `${fx.OTHER_ORIGIN}/lane-approval/${LANE_REQUEST}`,
    },
  ],
  [
    "http",
    {
      ...LANE_APPROVAL,
      url: `http://forge.example.test/lane-approval/${LANE_REQUEST}`,
    },
  ],
  [
    "another path",
    { ...LANE_APPROVAL, url: `${fx.ORIGIN}/login/${LANE_REQUEST}` },
  ],
  [
    "another request in path",
    {
      ...LANE_APPROVAL,
      url: `${fx.ORIGIN}/lane-approval/00000000-0000-4000-8000-000000000009`,
    },
  ],
  ["missing request", { ...LANE_APPROVAL, request: undefined }],
  ["invalid expiry", { ...LANE_APPROVAL, expiresAt: "tomorrow" }],
  ["an extra field", { ...LANE_APPROVAL, extra: true }],
  ["success with a valid pending approval", LANE_APPROVAL],
  [
    "success with another origin",
    {
      ...LANE_APPROVAL,
      url: `${fx.OTHER_ORIGIN}/lane-approval/${LANE_REQUEST}`,
    },
  ],
  [
    "success with http",
    {
      ...LANE_APPROVAL,
      url: `http://forge.example.test/lane-approval/${LANE_REQUEST}`,
    },
  ],
  [
    "success with another path",
    { ...LANE_APPROVAL, url: `${fx.ORIGIN}/login/${LANE_REQUEST}` },
  ],
] as const)
  test(
    `bound resume refuses an invalid approval result with ${name}`,
    () =>
      using(
        {
          steps: [
            () =>
              name.startsWith("success")
                ? answer(result, "lane.resume")
                : laneRequired(result),
          ],
        },
        async (r) => {
          const before = inventory(r.s.dir);
          expect(
            failed(
              await r.assembly.catalog.invoke(
                r.request("lane.resume", { all: true }),
              ),
              "UNAVAILABLE",
            ),
          ).toBe(1);
          expect(r.net.calls).toHaveLength(1);
          expect(inventory(r.s.dir)).toEqual(before);
        },
      ),
    30_000,
  );

for (const op of ["lane.stop", "lane.control", "lane.resume"] as const)
  for (const bad of ["malformed", "outage"] as const)
    test(
      `bound ${op} fails closed on ${bad} without local fallback`,
      () =>
        using(
          {
            steps: [
              () => {
                if (bad === "outage") throw new Error("offline");
                return answer({ invalid: true }, op);
              },
            ],
          },
          async (r) => {
            const before = inventory(r.s.dir);
            const input = op === "lane.control" ? {} : { all: true };
            expect(
              failed(
                await r.assembly.catalog.invoke(r.request(op, input)),
                "UNAVAILABLE",
              ),
            ).toBe(1);
            expect(r.net.calls).toHaveLength(1);
            expect(inventory(r.s.dir)).toEqual(before);
          },
        ),
      30_000,
    );

test(
  "unbound lane stop, control and relayed resume keep their local approval path",
  () =>
    using({ bind: false, creds: false, sentinel: false }, async (r) => {
      const call = (op: string, input: Record<string, unknown>) =>
        r.assembly.catalog.invoke(r.request(op, input));
      expect(await call("lane.stop", { all: true })).toMatchObject({
        ok: true,
      });
      expect(await call("lane.control", {})).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Lane control requires a cloud-bound project",
        },
      });
      const required = await call("lane.resume", { all: true });
      expect(required).toMatchObject({
        ok: false,
        error: { code: "APPROVAL_REQUIRED" },
        result: {
          request: {
            ask: "Resume every stopped lane. Forge starts spending calls and time again.",
          },
        },
      });
      const approval = approvalReply(required, {
        harness: "fixture",
        thread: "fixture",
      });
      expect(
        await call("lane.resume", {
          all: true,
          approval: { request: approval.request },
        }),
      ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
      expect(await call("lane.resume", { all: true, approval })).toMatchObject({
        ok: true,
        result: { resumed: "all" },
      });
      expect(await call("lane.control", {})).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Lane control requires a cloud-bound project",
        },
      });
      expect(r.net.calls).toHaveLength(0);
    }),
  30_000,
);

test(
  "unbound lane unfreeze needs the owner's relayed approval",
  () =>
    using({ bind: false, creds: false, sentinel: false }, async (r) => {
      const call = (op: string, input: Record<string, unknown>) =>
        r.assembly.catalog.invoke(r.request(op, input));
      expect(await call("lane.freeze", {})).toMatchObject({
        ok: true,
        result: { frozen: true },
      });
      const required = await call("lane.unfreeze", {});
      expect(required).toMatchObject({
        ok: false,
        error: { code: "APPROVAL_REQUIRED" },
        result: {
          request: {
            ask: "Unfreeze the local tracker store. Sessions on this machine can write issues to it again.",
          },
        },
      });
      expect(
        await call("issue.create", { title: "blocked", kind: "task" }),
      ).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      const approval = approvalReply(required, {
        harness: "fixture",
        thread: "fixture",
      });
      expect(await call("lane.unfreeze", { approval })).toMatchObject({
        ok: true,
        result: { frozen: false },
      });
      expect(
        await call("issue.create", { title: "allowed", kind: "task" }),
      ).toMatchObject({ ok: true });
    }),
  30_000,
);

test("local lane asks quote caller fields and still require relayed approval", async () => {
  let attended = true;
  await using(
    { bind: false, creds: false, sentinel: false, attended: () => attended },
    async (r) => {
      r.confirm.mockResolvedValue(true);
      writeOwnerPolicy(r.s.deviceRoot);
      const channel = {
        harness: 'owner"\t\\',
        thread: "thread\n\u2028\u2029\u202e",
      };
      const id = 'lane"\t\\\n\u202e';
      const ownerAsk = (harness: string, thread: string) =>
        `Make ${harness} thread ${thread} the owner channel. Replies from it become approvals for gated lane steps.`;
      const resumeAsk = (lane: string) =>
        `Resume lane ${lane}. Forge starts spending calls and time on it again.`;
      const asks = [];
      const trust = new LocalState(join(r.s.deviceRoot, "trust.sqlite"));
      const project = new LocalState(STORE(r.s));
      const context = localContext(r.assembly, { kind: "human", id: "owner" });
      const call = (op: string, input: object) =>
        r.assembly.catalog.invoke(
          r.request(op, input, { caller: "human", context }),
        );
      try {
        for (attended of [true, false]) {
          for (const [op, input, canonical] of [
            [
              "lane.record",
              { ownerChannel: channel },
              ownerAsk(channel.harness, channel.thread),
            ],
            ["lane.resume", { id }, resumeAsk(id)],
          ] as const) {
            const pending = await call(op, input);
            expect(failed(pending, "APPROVAL_REQUIRED")).toBe(1);
            const approval = approvalReply(pending);
            const { ask, binding } = (
              pending.result as { request: { ask: string; binding: string } }
            ).request;
            const owner = await trust.open(false);
            expect(
              owner?.get("forge/core-approvals", approval.request)?.value,
            ).toMatchObject({ ask: canonical, binding, status: "pending" });
            asks.push(ask);
            if (op === "lane.record") {
              expect(
                failed(
                  await call(op, {
                    ownerChannel: { ...channel, thread: "elsewhere" },
                    approval,
                  }),
                  "APPROVAL_REQUIRED",
                ),
              ).toBe(1);
              expect(exitCode(await call(op, { ...input, approval }))).toBe(0);
            }
          }
        }
        expect(r.confirm).not.toHaveBeenCalled();
        const state = await project.open(false);
        expect(
          state?.get("forge/work", "autopilot:global")?.value,
        ).toMatchObject({ owner: { channel } });
        const expected = [
          ownerAsk(
            '"owner\\"\\u0009\\\\"',
            '"thread\\u000a\\u2028\\u2029\\u202e"',
          ),
          resumeAsk('"lane\\"\\u0009\\\\\\u000a\\u202e"'),
        ];
        expect(asks).toEqual([...expected, ...expected]);
      } finally {
        await project.close();
        await trust.close();
      }
    },
  );
}, 30_000);
