import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProcessPort } from "../../src/adapters/process/index.ts";
import type { InspectRequest } from "../../tools/lane-step-contract.ts";
import type { InspectReads, LaneRecord } from "../../tools/lane-step.ts";
import {
  laneCli,
  laneGit,
  laneRepository,
} from "../blocks/l7-work/lane-repository-fixture.ts";

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function inspectFixture() {
  const root = resolve(tmpdir(), "lane-step-fake");
  const bytes = new TextEncoder().encode("Approved brief\r\n");
  const request: InspectRequest = {
    issue: "sample-1",
    brief: { path: join(root, "brief.md"), digest: digest(bytes) },
    workspace: join(root, "workspace"),
    branch: "feat/sample-1",
    expectedHead: "a".repeat(40),
  };
  const now = Date.UTC(2026, 0, 1);
  const holder = { actor: "local-cli", session: "builder", device: "fixture" };
  const lease = { holder, expiresAt: new Date(now + 1).toISOString() };
  const facts = {
    now,
    caller: { ...holder },
    lane: {
      issue: request.issue,
      worktree: request.workspace,
      branch: request.branch,
      brief: request.brief.path,
      lease,
    } as LaneRecord | undefined,
    bytes,
    workspace: {
      branch: request.branch,
      head: request.expectedHead,
      status: "",
    },
  };
  const calls: string[] = [];
  const read = <Key extends keyof typeof facts>(key: Key) => {
    calls.push(key);
    return facts[key];
  };
  const reads: InspectReads = {
    lane: () => Promise.resolve(read("lane")),
    brief: () => Promise.resolve(read("bytes")),
    workspace: () => Promise.resolve(read("workspace")),
    caller: () => Promise.resolve(read("caller")),
    now: () => read("now"),
  };
  return { request, facts, reads, calls };
}

export function expectedContext(request: InspectRequest) {
  return {
    issue: request.issue,
    workspace: request.workspace,
    branch: request.branch,
    head: request.expectedHead,
    digest: request.brief.digest,
  };
}

export function cliFixture(root: string) {
  const relativeBrief = ".worktrees/briefs/lane.md";
  const { repo } = laneRepository(root, relativeBrief);
  const session = "lane-step-builder";
  const device = "lane-step-fixture";
  const forge = (args: string[]) => {
    const reply = laneCli(root, repo, args, session, {
      FORGE_DEVICE_ID: device,
    });
    if (!reply.ok) throw new Error(JSON.stringify(reply));
    return reply.result;
  };
  const issue = String(
    forge(["issue", "create", "--title", "Inspect lane"]).id,
  );
  forge(["issue", "claim", issue]);
  const branch = "feat/inspect";
  const lane = forge([
    "lane",
    "start",
    issue,
    "--branch",
    branch,
    "--brief",
    relativeBrief,
  ]);
  const path = String(lane.brief);
  const workspace = String(lane.worktree);
  const request: InspectRequest = {
    issue,
    brief: { path, digest: digest(readFileSync(path)) },
    workspace,
    branch,
    expectedHead: laneGit(["rev-parse", "HEAD"], workspace),
  };
  const gitDirectory = laneGit(["rev-parse", "--absolute-git-dir"], workspace);
  const snapshot = () => ({
    registry: readFileSync(join(repo, ".git", "forge-lanes.json"), "utf8"),
    brief: readFileSync(path),
    index: readFileSync(join(gitDirectory, "index")),
    refs: laneGit(["show-ref"], repo),
    branch: laneGit(["symbolic-ref", "HEAD"], workspace),
    status: laneGit(
      ["--no-optional-locks", "status", "--porcelain"],
      workspace,
    ),
    issue: forge(["issue", "show", issue]),
  });
  const proc = createProcessPort({
    supervision: {
      cleanupTimeoutMs: 5000,
      pollIntervalMs: 25,
      drainTimeoutMs: 250,
      maxConcurrent: 1,
    },
  });
  const env: Record<string, string> = {
    FORGE_DEVICE_ID: device,
    FORGE_DEVICE_ROOT: join(root, "device"),
    FORGE_SESSION: session,
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE)$/i.test(
        key,
      )
    )
      env[key] = value;
  }
  const run = (
    input: unknown,
    args: string[] = [],
    command = ["inspect"],
    cwd = repo,
  ) =>
    proc.run(
      { kind: "resolved", path: process.execPath },
      [
        ...args,
        resolve(import.meta.dirname, "../../tools/lane-step.ts"),
        ...command,
      ],
      {
        cwd,
        env,
        stdin: JSON.stringify(input),
        timeoutMs: 20_000,
        maxOutputBytes: 16_384,
      },
    );
  function runWithBranchSwitch(branch: string) {
    laneGit(["branch", branch, request.expectedHead], workspace);
    const preload = join(root, "before-status.ts");
    const adapter = resolve(
      import.meta.dirname,
      "../../src/adapters/process/index.ts",
    );
    writeFileSync(
      preload,
      `
import { mock } from "bun:test";
import * as processAdapter from ${JSON.stringify(adapter)};
const { createProcessPort } = processAdapter;
mock.module(${JSON.stringify(adapter)}, () => ({
  ...processAdapter,
  createProcessPort(options) {
    const port = createProcessPort(options);
    return {
      ...port,
      async run(executable, args, spawnOptions) {
        if (args.includes("status") && args.includes("--porcelain")) {
          const switched = await port.run(executable, ["switch", "--quiet", ${JSON.stringify(branch)}], spawnOptions);
          if (switched.exitCode !== 0) throw new Error(switched.stderr);
        }
        return port.run(executable, args, spawnOptions);
      },
    };
  },
}));
`,
    );
    return run(request, ["--preload", preload]);
  }
  const head = () => laneGit(["rev-parse", "HEAD"], workspace);
  return { repo, request, snapshot, run, runWithBranchSwitch, head, forge };
}
