import { acceptanceTable } from "./lane-brief-fixture.ts";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

setDefaultTimeout(180_000);
const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
const head = "a".repeat(40);
const merge = "b".repeat(40);
const url = "https://github.com/example/repo/pull/7";
const brief = ".worktrees/briefs/tail.md";
let root: string;
let repo: string;
let fake: string;

function git(args: string[], cwd = repo) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
type Envelope = {
  ok: boolean;
  result: Record<string, unknown>;
  error?: { code: string; message: string };
};
// Each call is a new process: nothing survives between calls except the on-disk store.
function call(op: string, input: unknown, session: string): Envelope {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^path$/i.test(name)),
  );
  env.PATH = `${fake}${delimiter}${process.env.PATH ?? ""}`;
  env.FORGE_DEVICE_ROOT = join(root, "device");
  env.FORGE_SESSION = session;
  const result = spawnSync(
    "node",
    [bin, ...op.split("."), "--input", JSON.stringify(input)],
    {
      cwd: repo,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 90000,
    },
  );
  expect(result.error).toBeUndefined();
  return JSON.parse(result.stdout) as Envelope;
}
function revisions() {
  const db = new Database(join(repo, ".forge/state.sqlite"), {
    readonly: true,
  });
  try {
    return Object.fromEntries(
      (
        db
          .query(
            "SELECT key, revision FROM state_records WHERE namespace = ? AND key LIKE 'autopilot%' ORDER BY key",
          )
          .all("forge/work") as { key: string; revision: number }[]
      ).map((row) => [row.key, row.revision]),
    );
  } finally {
    db.close();
  }
}
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "forge-autopilot-")));
  const origin = join(root, "origin.git");
  repo = join(root, "project");
  fake = join(root, "fake");
  git(["init", "--bare", "--initial-branch=main", origin], root);
  git(["clone", origin, repo], root);
  git(["config", "user.name", "Lane test"]);
  git(["config", "user.email", "lane@example.test"]);
  writeFileSync(join(repo, "tracked"), "base\n");
  git(["add", "tracked"]);
  git(["commit", "-m", "base"]);
  git(["push", "origin", "main"]);
  git(["remote", "set-head", "origin", "main"]);
  mkdirSync(join(repo, ".forge"));
  writeFileSync(
    join(repo, ".forge/config.yaml"),
    "schemaVersion: forge.config/1\nblocks:\n  work:\n    source: { builtin: forge/work }\n    bind: { state: core }\n    config: { idPrefix: sample, lanes: { autopilot: { receiptChecks: [typecheck] } } }\n",
  );
  mkdirSync(join(repo, ".worktrees/briefs"), { recursive: true });
  writeFileSync(
    join(repo, brief),
    [
      "Goal",
      "Acceptance test",
      "Files",
      "Forbidden actions",
      "Stop point",
      "Prior art",
    ]
      .map(
        (name) =>
          `## ${name}\nConcrete content.\n${name === "Acceptance test" ? acceptanceTable : ""}\n`,
      )
      .join("\n"),
  );
  // A fake gh that prints a scenario file, as the pr-state fixture does.
  mkdirSync(fake);
  const node = Bun.which("node")!;
  writeFileSync(
    join(fake, "gh.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'process.stdout.write(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pr.json"), "utf8"));',
      "",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    writeFileSync(
      join(fake, "gh.cmd"),
      `@"${node}" "${join(fake, "gh.mjs")}" %*\r\n`,
    );
  } else {
    writeFileSync(
      join(fake, "gh"),
      `#!/bin/sh\nexec "${node}" "${join(fake, "gh.mjs")}" "$@"\n`,
    );
    chmodSync(join(fake, "gh"), 0o755);
  }
}, 180_000);
afterAll(() => rmSync(root, { recursive: true, force: true }), 60_000);

test("a fresh process resumes the pending action and a repeat writes nothing", () => {
  const created = call("issue.create", { title: "Tail" }, "first");
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const id = String(created.result.id);
  const started = call(
    "lane.start",
    { id, branch: `feat/${id}`, brief },
    "first",
  );
  expect(started.ok, JSON.stringify(started)).toBe(true);
  writeFileSync(
    join(fake, "pr.json"),
    JSON.stringify({
      state: "MERGED",
      headRefName: `feat/${id}`,
      headRefOid: head,
      mergeCommit: { oid: merge },
      url,
    }),
  );

  const first = call("lane.next", { id, pr: 7, head }, "first");
  expect(first.ok, JSON.stringify(first)).toBe(true);
  expect(first.result).toMatchObject({ step: "receipt", n: 1, kind: "forge" });
  const stored = revisions();
  expect(stored["autopilot:work-1"]).toBe(1);
  expect(
    Object.keys(stored).filter((key) => key.startsWith("autopilot-event:")),
  ).toHaveLength(1);

  // A second process with another session and no head argument reads the journal.
  const second = call("lane.next", { id, pr: 7 }, "second");
  expect(second.ok, JSON.stringify(second)).toBe(true);
  expect(second.result).toEqual(first.result);
  expect(revisions()).toEqual(stored);

  // A recorded receipt id survives to a third process, which cannot verify it and pauses.
  const recorded = call(
    "lane.record",
    { id, action: 1, result: JSON.stringify({ receipt: "missing" }) },
    "second",
  );
  expect(recorded.ok, JSON.stringify(recorded)).toBe(true);
  const third = call("lane.next", { id, pr: 7 }, "third");
  expect(third.ok, JSON.stringify(third)).toBe(true);
  expect(third.result).toMatchObject({ kind: "pause", step: "receipt", n: 1 });
  expect(String(third.result.raw)).toContain("missing");
  const after = revisions();
  expect(after["autopilot:work-1"]).toBe(2);
  const again = call("lane.next", { id, pr: 7 }, "fourth");
  expect(again.result).toEqual(third.result);
  expect(revisions()).toEqual(after);
});
