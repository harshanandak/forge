// [integration] Real package entry, Git projects and a linked checkout use isolated stores.
import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import { removeQuietly, spawnBudget } from "../spawn-budget.ts";

const repo = resolve(import.meta.dirname, "../..");

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), "forge-project-routing-"));
  const budget = spawnBudget(30_000);
  const env: Record<string, string> = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(sandbox, "gitconfig");
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  env.FORGE_DEVICE_ROOT = join(sandbox, "device");
  const a = join(sandbox, "project-a");
  const b = join(sandbox, "project-b");
  const install = join(sandbox, "installed");
  const config = JSON.stringify({
    schemaVersion: "forge.config/1",
    blocks: { work: { source: { builtin: "forge/work" } } },
  });
  function git(cwd: string, ...args: string[]) {
    return budget.run("git " + args.join(" "), "git", args, { cwd, env }, 0);
  }
  function project(root: string, origin: string) {
    mkdirSync(join(root, ".forge"), { recursive: true });
    writeFileSync(join(root, ".forge/config.yaml"), config);
    git(root, "init", "--quiet");
    git(
      root,
      "remote",
      "add",
      "origin",
      `https://example.invalid/team/${origin}.git`,
    );
  }
  try {
    project(a, "acme");
    project(b, "beta");
    // The executable and its assets live outside either caller's project.
    cpSync(join(repo, "dist"), join(install, "dist"), { recursive: true });
    cpSync(join(repo, "templates"), join(install, "templates"), {
      recursive: true,
    });
    cpSync(join(repo, "package.json"), join(install, "package.json"));
    symlinkSync(
      join(repo, "node_modules"),
      join(install, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const manifest = JSON.parse(
      readFileSync(join(install, "package.json"), "utf8"),
    ) as {
      bin: { forge: string };
    };
    const bin = join(install, manifest.bin.forge);
    function call(cwd: string, args: string[], status = 0): ResultEnvelope {
      const reply = budget.run(
        "forge " + args.join(" "),
        "node",
        [bin, ...args],
        {
          cwd,
          env: { ...env, FORGE_CWD: a },
        },
        status,
      );
      return JSON.parse(reply.stdout) as ResultEnvelope;
    }
    const create = (cwd: string, title: string) =>
      call(cwd, ["issue", "create", "--title", title]);
    const list = (cwd: string) => call(cwd, ["issue", "list"]);
    return { sandbox, a, b, install, git, project, call, create, list };
  } catch (error) {
    removeQuietly(sandbox);
    throw error;
  }
}

function seed(f: ReturnType<typeof fixture>) {
  expect(f.create(f.a, "Only A")).toMatchObject({
    ok: true,
    result: { id: "acme-1" },
  });
  expect(f.list(f.b)).toMatchObject({ ok: true, result: { items: [] } });
  expect(f.create(f.b, "Only B")).toMatchObject({
    ok: true,
    result: { id: "beta-1" },
  });
}

function expectIssues(f: ReturnType<typeof fixture>) {
  for (const [cwd, id, title] of [
    [f.a, "acme-1", "Only A"],
    [f.b, "beta-1", "Only B"],
  ] as const) {
    const listed = f.list(cwd);
    expect(listed.ok).toBe(true);
    const result = listed.result as { items: { id: string; title: string }[] };
    expect(result.items.map(({ id, title }) => ({ id, title }))).toEqual([
      { id, title },
    ]);
  }
}

function snapshot(f: ReturnType<typeof fixture>) {
  return [f.a, f.b].map((root) =>
    readFileSync(join(root, ".forge/state.sqlite")),
  );
}

test("the shipped bin keeps A and B isolated from its install location and an unrelated cwd default", () => {
  const f = fixture();
  try {
    seed(f);
    expectIssues(f);
    expect(existsSync(join(f.install, ".forge"))).toBe(false);
  } finally {
    removeQuietly(f.sandbox);
  }
}, 30_000);

test("a linked checkout shares A's store while B keeps its own store", () => {
  const f = fixture();
  try {
    seed(f);
    f.git(f.a, "add", ".forge/config.yaml");
    f.git(
      f.a,
      "-c",
      "user.name=Forge Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Project configuration",
    );
    const linked = join(f.sandbox, "linked-a");
    f.git(f.a, "worktree", "add", "--detach", linked, "HEAD");
    expect(f.list(linked)).toMatchObject({
      ok: true,
      result: { items: [{ id: "acme-1", title: "Only A" }] },
    });
    expect(f.create(linked, "From linked checkout")).toMatchObject({
      ok: true,
      result: { id: "acme-2" },
    });
    const listed = f.list(f.a).result as { items: { id: string }[] };
    expect(listed.items.map(({ id }) => id).sort()).toEqual([
      "acme-1",
      "acme-2",
    ]);
    expect(f.list(f.b)).toMatchObject({
      ok: true,
      result: { items: [{ id: "beta-1", title: "Only B" }] },
    });
    expect(existsSync(join(linked, ".forge/state.sqlite"))).toBe(false);
  } finally {
    removeQuietly(f.sandbox);
  }
}, 30_000);

for (const fault of ["config", "store"] as const) {
  test(`a broken ${fault} refuses with its project root and leaves both other stores untouched`, () => {
    const f = fixture();
    try {
      seed(f);
      const broken = join(f.sandbox, `broken-${fault}`);
      f.project(broken, "broken");
      const path = join(
        broken,
        ".forge",
        fault === "config" ? "config.yaml" : "state.sqlite",
      );
      if (fault === "config") writeFileSync(path, "blocks: [\n");
      else mkdirSync(path);
      const before = snapshot(f);
      const refused = f.call(
        broken,
        ["issue", "create", "--title", "Must refuse"],
        fault === "config" ? 6 : 1,
      );
      expect(snapshot(f)).toEqual(before);
      expectIssues(f);
      expect(existsSync(join(f.install, ".forge"))).toBe(false);
      if (fault === "config")
        expect(existsSync(join(broken, ".forge/state.sqlite"))).toBe(false);
      expect(refused).toMatchObject({
        ok: false,
        error: {
          code: fault === "config" ? "INPUT_INVALID" : "UNAVAILABLE",
          retry: "never",
        },
      });
      if (refused.ok)
        throw new Error("Broken project unexpectedly accepted the write");
      expect(refused.error.message).toContain(realpathSync.native(broken));
    } finally {
      removeQuietly(f.sandbox);
    }
  }, 30_000);
}
