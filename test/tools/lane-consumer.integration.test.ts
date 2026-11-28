import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { laneRun } from "../../tools/lane-run.ts";
import * as laneStep from "../../tools/lane-step.ts";
import type { InspectReads } from "../../tools/lane-step.ts";
import type {
  InspectRefusal,
  LaneStepContext,
} from "../../tools/lane-step-contract.ts";
import { laneGit } from "../blocks/l7-work/lane-repository-fixture.ts";
import { bindingFor } from "../assembly/cloud-fixture.ts";
import {
  cliFixture,
  expectedContext,
  inspectFixture,
} from "./lane-step-fixture.ts";

setDefaultTimeout(30_000);

type Reads = InspectReads & {
  control: (id: string) => Promise<"running" | "stopped" | "unknown">;
};
type Consume = (
  input: unknown,
  reads?: Reads,
) => Promise<InspectRefusal | { status: "verified"; brief: Uint8Array }>;
const consume = (laneStep as { consume?: Consume }).consume;
const consumerTest = test.skipIf(!consume);
const request = (context: LaneStepContext) => ({
  context,
  step: { kind: "verify-brief" },
});
const refused = (field: string, code: string): InspectRefusal => ({
  status: "refused",
  field,
  code,
});

async function withLane(
  use: (f: ReturnType<typeof cliFixture>, root: string) => Promise<void>,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-consumer-")));
  try {
    await use(cliFixture(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function inspected(f: ReturnType<typeof cliFixture>) {
  const result = await f.run(f.request);
  expect(result.exitCode, result.stderr).toBe(0);
  const context = expectedContext(f.request);
  expect(JSON.parse(result.stdout)).toEqual({ status: "context", context });
  return request(context);
}

function legacyPolicy(repo: string) {
  appendFileSync(
    join(repo, ".forge/config.yaml"),
    "values:\n  lanes:\n    tiers: {security: [], code: []}\n    roles:\n      reviewer: {harness: codex, model: fixture, effort: high}\n",
  );
  laneGit(["add", ".forge/config.yaml"], repo);
  laneGit(["commit", "-m", "trusted runner policy"], repo);
  laneGit(["push", "origin", "main"], repo);
}

async function legacyDispatch(
  f: ReturnType<typeof cliFixture>,
  root: string,
  marker: string,
) {
  const bin = join(root, "bin");
  const forge = join(bin, "forge.mjs");
  const codex = join(bin, "codex");
  writeFileSync(
    forge,
    "console.log(JSON.stringify({ok:true,result:{id:process.argv[2]}}));\n",
  );
  writeFileSync(
    codex,
    '#!/bin/sh\nprintf dispatch > "$FORGE_WITNESS"\nwhile [ "$1" != "-o" ]; do shift; done\ncat > "$2"\n',
  );
  chmodSync(codex, 0o755);
  const path = process.env.PATH;
  process.env.PATH = [bin, path].join(delimiter);
  process.env.FORGE_WITNESS = marker;
  const { issue, workspace: worktree, branch, brief } = f.request;
  let report = "";
  try {
    const code = await laneRun([issue, "--role", "reviewer"], {
      common: join(f.repo, ".git"),
      configRoot: f.repo,
      lanes: [{ issue, worktree, branch, brief: brief.path }],
      issue: (id) => {
        const fake = spawnSync(process.execPath, [forge, id], {
          encoding: "utf8",
        });
        if (fake.status !== 0) throw new Error(fake.stderr);
        return fake.stdout;
      },
      lock: () => () => {},
      report: (json) => {
        report = json;
      },
    });
    expect(code, report).toBe(0);
  } finally {
    delete process.env.FORGE_WITNESS;
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
}

for (const fault of ["brief edit", "head move"] as const) {
  const edited = fault === "brief edit";
  test(`${edited ? "A6" : "A7"} ${fault} after inspect refuses before dispatch`, () =>
    withLane(async (f, root) => {
      if (!consume) legacyPolicy(f.repo);
      const input = await inspected(f);
      if (edited) writeFileSync(f.request.brief.path, "Replacement brief\r\n");
      else
        laneGit(
          ["commit", "--allow-empty", "-m", "move HEAD"],
          f.request.workspace,
        );
      const marker = join(root, "dispatch");
      const before = f.snapshot();
      const result = consume
        ? await f.run(input, [], ["consume"])
        : await legacyDispatch(f, root, marker);
      expect(
        existsSync(marker),
        "a harness started after inspection became stale",
      ).toBe(false);
      expect(existsSync(join(f.repo, ".git/forge-lane-runs"))).toBe(false);
      expect(f.snapshot()).toEqual(before);
      expect(result?.exitCode).toBe(2);
      expect(JSON.parse(result?.stdout ?? "{}")).toEqual(
        edited
          ? refused("brief.digest", "BRIEF_DIGEST_MISMATCH")
          : refused("head", "CONTEXT_MISMATCH"),
      );
    }));
}

function consumerFixture() {
  const f = inspectFixture();
  const reads: Reads = {
    ...f.reads,
    control: () => Promise.resolve("running"),
  };
  return { ...f, reads, input: request(expectedContext(f.request)) };
}

consumerTest("A1 and A12 reject complete input before any read", async () => {
  const { input, calls, reads } = consumerFixture();
  const { head: _head, ...missingHead } = input.context;
  const invalid = [
    {},
    { ...input, env: {} },
    { ...input, context: missingHead },
    { ...input, context: { ...input.context, path: "/brief" } },
    { ...input, context: { ...input.context, digest: "wrong" } },
    { ...input, step: {} },
    { ...input, step: { ...input.step, argv: ["anything"] } },
    { ...input, step: { ...input.step, prompt: "/brief" } },
    { ...input, step: { ...input.step, executable: "/program" } },
    ...["run", "auto", "--prompt", "check run", "lane next"].map((kind) => ({
      ...input,
      step: { kind },
    })),
    { ...input, step: { kind: "harness", n: 1, raw: "{}" } },
  ];
  for (const row of invalid) {
    expect(await consume!(row, reads)).toMatchObject({
      status: "refused",
      code: "INPUT_INVALID",
    });
  }
  expect(calls).toEqual([]);
});

consumerTest("A4 rechecks workspace and current lease", async () => {
  const fixtures = {
    dirty: consumerFixture(),
    branch: consumerFixture(),
    tree: consumerFixture(),
    expired: consumerFixture(),
    session: consumerFixture(),
    holder: consumerFixture(),
  };
  const { dirty, branch, tree, expired, session, holder } = fixtures;
  dirty.facts.workspace.status = "?? file";
  branch.facts.workspace.branch = "feat/moved";
  expired.facts.now++;
  session.facts.caller.session = "someone-else";
  holder.facts.caller.device = "another-device";
  for (const [f, input, wanted] of [
    [dirty, dirty.input, refused("workspace", "WORKTREE_DIRTY")],
    [branch, branch.input, refused("branch", "CONTEXT_MISMATCH")],
    [
      tree,
      request({ ...tree.input.context, workspace: tmpdir() }),
      refused("workspace", "CONTEXT_MISMATCH"),
    ],
    [expired, expired.input, refused("lease", "LEASE_EXPIRED")],
    [session, session.input, refused("lease", "LEASE_NOT_HELD")],
    [holder, holder.input, refused("lease", "LEASE_NOT_HELD")],
  ] as const) {
    const before = structuredClone(f.facts);
    expect(await consume!(input, f.reads)).toEqual(wanted);
    expect(f.facts).toEqual(before);
  }
});

consumerTest("A5 CLI honors the config switch and a local stop", () =>
  withLane(async (f) => {
    const input = await inspected(f);
    const configPath = join(f.repo, ".forge/config.yaml");
    const config = readFileSync(configPath, "utf8");
    const refusesStop = async () => {
      const before = f.snapshot();
      const stopped = await f.run(input, [], ["consume"]);
      expect(stopped.exitCode).toBe(2);
      expect(JSON.parse(stopped.stdout)).toEqual(
        refused("control", "LANE_STOPPED"),
      );
      expect(f.snapshot()).toEqual(before);
    };
    writeFileSync(
      configPath,
      config.replace("lanes: {", 'lanes: {"autopilot":{"enabled":false},'),
    );
    await refusesStop();
    writeFileSync(configPath, config);
    f.forge(["lane", "stop", f.request.issue]);
    await refusesStop();
  }),
);

consumerTest("A5 CLI refuses a cloud-bound project", () =>
  withLane(async (f) => {
    const input = await inspected(f);
    const before = f.snapshot();
    const binding = bindingFor();
    writeFileSync(
      join(f.repo, ".forge/project.json"),
      JSON.stringify({ schema: 1, id: binding.identity }),
    );
    writeFileSync(join(f.repo, ".forge/cloud.json"), JSON.stringify(binding));
    const result = await f.run(input, [], ["consume"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual(refused("issue", "UNAVAILABLE"));
    rmSync(join(f.repo, ".forge/cloud.json"));
    rmSync(join(f.repo, ".forge/project.json"));
    expect(f.snapshot()).toEqual(before);
  }),
);

consumerTest(
  "A5 unknown control and inaccessible lane authority fail closed",
  async () => {
    const { input, reads } = consumerFixture();
    expect(
      await consume!(input, {
        ...reads,
        control: () => Promise.resolve("unknown"),
      }),
    ).toEqual(refused("control", "UNAVAILABLE"));
    expect(
      await consume!(input, {
        ...reads,
        lane: () => Promise.reject(new Error("unavailable")),
      }),
    ).toEqual(refused("issue", "UNAVAILABLE"));
  },
);

consumerTest(
  "A8 delivers only the once-read CRLF bytes despite a later edit",
  async () => {
    const { input, reads, facts, calls } = consumerFixture();
    const original = facts.bytes.slice();
    const result = await consume!(input, {
      ...reads,
      workspace: () => {
        facts.bytes.fill(0);
        return reads.workspace(input.context.workspace);
      },
    });
    expect(result).toEqual({ status: "verified", brief: original });
    expect(calls.filter((call) => call === "bytes")).toHaveLength(1);
  },
);

consumerTest(
  "A9 refuses an unreadable brief before workspace reads",
  async () => {
    const { input, reads, calls } = consumerFixture();
    const result = await consume!(input, {
      ...reads,
      brief: () => Promise.reject(new Error("EACCES")),
    });
    expect(result).toEqual(refused("brief.path", "UNAVAILABLE"));
    expect(calls).toEqual(["lane"]);
  },
);

consumerTest("A9 refuses unsafe brief files and invalid UTF-8", () =>
  withLane(async (f, root) => {
    const input = await inspected(f);
    const path = f.request.brief.path;
    const other = join(root, "outside");
    renameSync(path, other);
    const rejects = async (candidate = input) => {
      const result = await f.run(candidate, [], ["consume"]);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual(
        refused("brief.path", "UNAVAILABLE"),
      );
    };
    await rejects();
    mkdirSync(path);
    await rejects();
    rmSync(path, { recursive: true });
    if (process.platform !== "win32") {
      symlinkSync(other, path);
      await rejects();
      rmSync(path);
    }
    writeFileSync(path, Buffer.alloc(262_145));
    await rejects();
    const bytes = Buffer.from([0xc0, 0xaf]);
    writeFileSync(path, bytes);
    const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    await rejects(request({ ...input.context, digest }));
  }),
);

consumerTest(
  "CLI consumes a valid context without emitting bytes and rejects extra argv",
  () =>
    withLane(async (f) => {
      const input = await inspected(f);
      const before = f.snapshot();
      const valid = await f.run(input, [], ["consume"]);
      const invalid = await f.run(
        input,
        [],
        ["consume", "--prompt", "replacement"],
      );
      expect(valid.exitCode).toBe(0);
      expect(JSON.parse(valid.stdout)).toEqual({ status: "verified" });
      expect(invalid.exitCode).toBe(2);
      expect(JSON.parse(invalid.stdout)).toEqual(
        refused("command", "INPUT_INVALID"),
      );
      expect(f.snapshot()).toEqual(before);
    }),
);
