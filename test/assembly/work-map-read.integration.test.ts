import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProcessPort } from "../../src/adapters/process/index.ts";
import {
  readWorkMap,
  WORK_MAP_LIMITS,
} from "../../src/assembly/work-map-read.ts";
import { gitExecutable } from "../../tools/git-executable.ts";

setDefaultTimeout(30000);

const defaultRef = "refs/remotes/origin/main";
const defaultPolicy = `schemaVersion: forge.config/1
blocks:
  work:
    source: { builtin: forge/work }
    config:
      generatedFiles:
        - glob: "gen/*.ts"
          regenerate: { argv: [regenerate] }
`;

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "forge-work-map-"));
  let git = gitExecutable();
  if (
    process.platform === "win32" &&
    /[\\/](?:cmd|bin)[\\/]git\.exe$/i.test(git)
  ) {
    const tools = spawnSync(git, ["--exec-path"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    if (tools.status !== 0) throw new Error("Git exec path is unavailable");
    git = resolve(tools.stdout.trim(), "..", "..", "bin", "git.exe");
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        /^(path|pathext|systemroot|windir|comspec|tmp|temp|tmpdir|home|userprofile)$/i.test(
          entry[0],
        ) && entry[1] !== undefined,
    ),
  );
  const gitEnv = {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(cwd, "absent-config"),
  };
  const command = (args: readonly string[], input?: string) => {
    const result = spawnSync(git, args, {
      cwd,
      env: gitEnv,
      input,
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status !== 0)
      throw new Error(
        `git ${args[0]}: ${result.error?.message ?? result.stderr}`,
      );
    return result.stdout.trim();
  };
  const close = () => rmSync(cwd, { recursive: true, force: true });
  try {
    command(["init", "-q", "-b", "candidate"]);
  } catch (error) {
    close();
    throw error;
  }
  function commit(paths: readonly string[], policy = defaultPolicy) {
    const blob = command(["hash-object", "-w", "--stdin"], policy);
    const tree = (entries: string) => command(["mktree", "-z"], entries);
    const config = tree(`100644 blob ${blob}\tconfig.yaml\0`);
    const root = tree(
      `040000 tree ${config}\t.forge\0` +
        paths.map((path) => `100644 blob ${blob}\t${path}\0`).join(""),
    );
    return command([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      root,
      "-m",
      "fixture",
    ]);
  }
  const executor = createProcessPort({
    supervision: {
      cleanupTimeoutMs: 5000,
      pollIntervalMs: 25,
      drainTimeoutMs: 250,
      maxConcurrent: 1,
    },
  });
  const adapter = {
    ...executor,
    resolve: () => ({ kind: "resolved" as const, path: git }),
  };
  function read(
    source = adapter,
    overrides: Readonly<Record<string, string>> = {},
  ) {
    return readWorkMap(
      {
        process: source,
        now: () => 0,
        issues: () => ({ items: [], truncated: false }),
        deliveries: () => ({ items: [], truncated: false }),
        pull: () => ({ state: "CLOSED" }),
        gitProcessCost: 1,
        pullProcessCost: () => 1,
      },
      { cwd, env: { ...gitEnv, ...overrides }, defaultRef, timeoutMs: 5000 },
    );
  }
  return { cwd, command, commit, close, read, adapter };
}

test("real Git pins the project default across ref movement and foreign Git environment overrides", async () => {
  const f = fixture();
  try {
    const paths = ["name with space.ts", "é.gen", "name\nwith-break.ts"];
    const base = f.commit(paths);
    const candidate = f.commit(
      ["candidate.ts"],
      defaultPolicy.replace("gen/*.ts", "candidate.ts"),
    );
    f.command(["update-ref", defaultRef, base]);
    f.command(["update-ref", "HEAD", candidate]);
    const foreign = join(f.cwd, "foreign.git");
    f.command(["clone", "-q", "--bare", ".", foreign]);
    f.command(["--git-dir", foreign, "update-ref", defaultRef, candidate]);
    const result = await f.read(
      {
        ...f.adapter,
        async run(git, args, opts) {
          const response = await f.adapter.run(git, args, opts);
          if (args.includes("rev-parse"))
            f.command(["update-ref", defaultRef, candidate]);
          return response;
        },
      },
      { GIT_DIR: foreign },
    );
    expect(result).toMatchObject({
      complete: true,
      defaultSha: base,
      generatedFiles: [
        { glob: "gen/*.ts", regenerate: { argv: ["regenerate"] } },
      ],
      holders: [],
    });
    expect(result.trackedPaths.sort()).toEqual(
      [".forge/config.yaml", ...paths].sort(),
    );
  } finally {
    f.close();
  }
});

test("a missing promisor policy blob never starts a Git fetch even without GIT_NO_LAZY_FETCH", async () => {
  const f = fixture();
  try {
    const base = f.commit(["tracked.ts"]);
    f.command(["update-ref", defaultRef, base]);
    f.command(["update-ref", "HEAD", base]);
    const remote = join(f.cwd, "origin.git");
    f.command(["clone", "-q", "--bare", ".", remote]);
    f.command(["remote", "add", "origin", remote]);
    f.command(["config", "remote.origin.promisor", "true"]);
    f.command(["config", "remote.origin.partialCloneFilter", "blob:none"]);
    const blob = f.command(["rev-parse", `${base}:.forge/config.yaml`]);
    const local = join(
      f.cwd,
      ".git",
      "objects",
      blob.slice(0, 2),
      blob.slice(2),
    );
    rmSync(local);
    const trace = join(f.cwd, "git-trace.jsonl");
    writeFileSync(trace, "");
    const policyObject = `${base}:.forge/config.yaml`;
    const attempted: string[][] = [];
    let policyExit: number | null = null;
    let policyError = "";
    const snapshot = await f.read({
      ...f.adapter,
      async run(git, args, options) {
        attempted.push([...args]);
        const { GIT_NO_LAZY_FETCH: _ignored, ...env } = options.env;
        const result = await f.adapter.run(git, args, {
          ...options,
          env: { ...env, GIT_TRACE2_EVENT: trace },
        });
        if (args.includes(policyObject)) {
          policyExit = result.exitCode;
          policyError = result.stderr;
        }
        return result;
      },
    });
    const events = readFileSync(trace, "utf8").trim().split("\n");
    expect(
      events.filter((line) => line.includes('"event":"start"')),
    ).toHaveLength(3);
    expect(
      events.some(
        (line) =>
          line.includes('"event":"start"') &&
          line.includes(`"cat-file","blob","${policyObject}"`),
      ),
    ).toBe(true);
    expect(
      events.filter((line) => line.includes('"event":"child_start"')),
      "Git child processes",
    ).toEqual([]);
    expect(attempted.at(-1)).toEqual([
      "--no-replace-objects",
      "--no-lazy-fetch",
      "cat-file",
      "blob",
      policyObject,
    ]);
    expect(policyExit ?? 0).not.toBe(0);
    expect(policyError).toMatch(/bad file|could not get object info/i);
    expect(snapshot).toMatchObject({
      complete: false,
      defaultSha: base,
      trackedPaths: [".forge/config.yaml", "tracked.ts"],
      reasons: [{ kind: "policy-unreadable", source: "generated-policy" }],
    });
    expect(existsSync(local)).toBe(false);
  } finally {
    f.close();
  }
});

test("Git's unsupported global-option response stops before an advisory object read", async () => {
  const f = fixture();
  try {
    f.command(["update-ref", defaultRef, f.commit(["tracked.ts"])]);
    const verbs: string[] = [];
    let parserError = "";
    const snapshot = await f.read({
      ...f.adapter,
      async run(git, args, options) {
        verbs.push(args[2] ?? "");
        const result = await f.adapter.run(
          git,
          args.map((arg) =>
            arg === "--no-lazy-fetch"
              ? "--fixture-unsupported-no-lazy-fetch"
              : arg,
          ),
          options,
        );
        parserError = result.stderr;
        return result;
      },
    });
    expect(verbs).toEqual(["rev-parse"]);
    expect(parserError).toContain("unknown option");
    expect(snapshot).toMatchObject({
      complete: false,
      trackedPaths: [],
      reasons: [{ kind: "git-unavailable", source: "default-ref" }],
    });
  } finally {
    f.close();
  }
});

test.each(["tracked paths", "output bytes"] as const)(
  "the real Git inventory reports its %s cut",
  async (budget) => {
    const f = fixture();
    try {
      const byteLimited = budget === "output bytes";
      const limit = WORK_MAP_LIMITS.trackedPaths;
      const paths = Array.from(
        { length: byteLimited ? limit / 2 : limit },
        (_, i) =>
          `file-${i.toString().padStart(6, "0")}`.padEnd(
            byteLimited ? 128 : 11,
            "z",
          ),
      );
      const base = f.commit(paths);
      f.command(["update-ref", defaultRef, base]);
      expect(await f.read()).toMatchObject({
        complete: false,
        defaultSha: base,
        reasons: [
          byteLimited
            ? { kind: "output-budget", source: "tracked-paths" }
            : { kind: "tracked-paths-truncated" },
        ],
        trackedPaths: byteLimited
          ? []
          : [".forge/config.yaml", ...paths.slice(0, -1)],
      });
    } finally {
      f.close();
    }
  },
);
