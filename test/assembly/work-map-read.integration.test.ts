import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const git = gitExecutable();
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
  const adapter = createProcessPort();
  function read(source = adapter) {
    return readWorkMap(
      {
        process: source,
        now: () => 0,
        issues: () => ({ items: [], truncated: false }),
        deliveries: () => ({ items: [], truncated: false }),
        pull: () => ({ state: "CLOSED" }),
      },
      { cwd, env: gitEnv, defaultRef, timeoutMs: 5000 },
    );
  }
  return { command, commit, close, read, adapter };
}

test("a real Git snapshot keeps the same SHA across default-ref movement and candidate commits", async () => {
  const f = fixture();
  try {
    const base = f.commit([
      "name with space.ts",
      "é.gen",
      "name\nwith-break.ts",
    ]);
    const candidate = f.commit(
      ["candidate.ts"],
      defaultPolicy.replace("gen/*.ts", "candidate.ts"),
    );
    f.command(["update-ref", defaultRef, base]);
    f.command(["update-ref", "HEAD", candidate]);
    const result = await f.read({
      ...f.adapter,
      async run(git, args, opts) {
        const response = await f.adapter.run(git, args, opts);
        if (args[1] === "rev-parse")
          f.command(["update-ref", defaultRef, candidate]);
        return response;
      },
    });
    expect(result).toMatchObject({
      complete: true,
      defaultSha: base,
      generatedFiles: [
        { glob: "gen/*.ts", regenerate: { argv: ["regenerate"] } },
      ],
      holders: [],
    });
    expect(result.trackedPaths.sort()).toEqual(
      [
        ".forge/config.yaml",
        "name with space.ts",
        "é.gen",
        "name\nwith-break.ts",
      ].sort(),
    );
  } finally {
    f.close();
  }
});

test("the real Git tree inventory stops at the tracked-path ceiling", async () => {
  const f = fixture();
  try {
    const paths = Array.from(
      { length: WORK_MAP_LIMITS.trackedPaths },
      (_, i) => `file-${i.toString().padStart(6, "0")}`,
    );
    const base = f.commit(paths);
    f.command(["update-ref", defaultRef, base]);
    const result = await f.read();
    expect(result).toMatchObject({
      complete: false,
      defaultSha: base,
      reasons: [{ kind: "tracked-paths-truncated" }],
    });
    expect(result.trackedPaths.length).toBe(WORK_MAP_LIMITS.trackedPaths);
    expect(result.trackedPaths.at(0)).toBe(".forge/config.yaml");
    expect(result.trackedPaths.at(-1)).toBe(paths.at(-2));
  } finally {
    f.close();
  }
});

test("a real Git output byte cut is explicit and cannot certify missing paths", async () => {
  const f = fixture();
  try {
    const paths = Array.from(
      { length: WORK_MAP_LIMITS.trackedPaths / 2 },
      (_, i) => `file-${i}`.padEnd(128, "z"),
    );
    const base = f.commit(paths);
    f.command(["update-ref", defaultRef, base]);
    expect(await f.read()).toMatchObject({
      complete: false,
      defaultSha: base,
      trackedPaths: [],
      reasons: [{ kind: "output-budget", source: "tracked-paths" }],
    });
  } finally {
    f.close();
  }
});
