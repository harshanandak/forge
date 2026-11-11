import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { cloudBinding } from "../../src/assembly/cloud-binding.ts";
import {
  credentialStore,
  openCloudFiles,
  type CredentialEntry,
} from "../../src/assembly/cloud-profile.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import * as fx from "./cloud-fixture.ts";

setDefaultTimeout(30_000);
type Box = fx.Sandbox;
const NOW = Date.UTC(2026, 10, 11);
const OWN_TOKEN = "O".repeat(43);
const BOUND = {
  kind: "bound",
  identity: fx.PROJECT_ID,
  origin: fx.ORIGIN,
  project: fx.PROJECT,
} as const;

/** Every path under `dir`, with the text of each file. */
const tree = (dir: string) =>
  (fs.readdirSync(dir, { recursive: true }) as string[]).sort().map((p) => {
    const full = join(dir, p);
    return fs.statSync(full).isFile()
      ? [p, fs.readFileSync(full, "utf8")]
      : [p];
  });
async function boxed(run: (s: Box) => unknown) {
  const s = fx.sandbox();
  try {
    await run(s);
  } finally {
    s.close();
  }
}
function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof ForgeFailure)
      return { code: error.error.code, message: error.error.message };
    throw error;
  }
  return undefined;
}
const bind = (s: Box, change = {}) =>
  fs.writeFileSync(s.binding, `${JSON.stringify(fx.bindingFor(change))}\n`);
const save = (s: Box, saved: CredentialEntry) =>
  credentialStore(openCloudFiles(s.home)).save(saved);
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
    {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: devNull },
      windowsHide: true,
      timeout: 20_000,
    },
  );
  expect(run.error).toBeUndefined();
  return run.status;
};
const manifest = (s: Box) => join(s.root, ".forge", "project.json");

test("a project with no binding and no remembered credential is unbound, and inspecting it creates nothing", () =>
  boxed((s) => {
    const before = tree(s.dir);
    const absent = join(s.dir, "absent-home");
    for (const home of [s.home, absent, undefined])
      expect(cloudBinding(s.root, home)).toEqual({ kind: "unbound" });
    expect(tree(s.dir)).toEqual(before);
    expect(fs.existsSync(join(s.home, ".forge"))).toBe(false);
    expect(fs.existsSync(absent)).toBe(false);
    // Project identity alone does not bind; with no manifest there is nothing to look up either.
    fs.rmSync(manifest(s));
    expect(cloudBinding(s.root, s.home)).toEqual({ kind: "unbound" });
  }));

test("a binding that matches the manifest is bound, with exactly its fields, and nothing is written", () =>
  boxed(async (s) => {
    bind(s);
    expect(cloudBinding(s.root, s.home)).toEqual(BOUND);
    // A remembered credential that agrees changes nothing, and no token is read into the result.
    await save(s, fx.entry(NOW));
    const saved = tree(s.dir);
    const got = cloudBinding(s.root, s.home);
    expect(got).toEqual(BOUND);
    expect(JSON.stringify(got)).not.toContain(OWN_TOKEN);
    expect(tree(s.dir)).toEqual(saved);
  }));

test("a nested folder and a linked worktree resolve to the same binding", () =>
  boxed((s) => {
    bind(s);
    const linked = join(s.dir, "linked");
    for (const args of [
      ["init", "--quiet"],
      ["add", ".forge/project.json", ".forge/cloud.json"],
      ["commit", "--quiet", "-m", "x"],
      ["worktree", "add", "--quiet", "--detach", linked, "HEAD"],
    ])
      expect([args[0], git(s.root, ...args)]).toEqual([args[0], 0]);
    for (const base of [s.root, linked]) {
      const nested = join(base, "src", "deep");
      fs.mkdirSync(nested, { recursive: true });
      expect([base, cloudBinding(nested, s.home)]).toEqual([base, BOUND]);
      expect(cloudBinding(base, s.home)).toEqual(BOUND);
    }
  }));

const own = (s: Box) => save(s, fx.entry(NOW));
const lapse = (s: Box) =>
  save(s, fx.entry(NOW, { expiresAt: new Date(NOW - fx.DAY).toISOString() }));
const other = (s: Box) => bind(s, { identity: fx.OTHER_PROJECT_ID });
const bad = (text: string) => (s: Box) => fs.writeFileSync(s.binding, text);
const gone = (s: Box) => {
  bind(s);
  fs.rmSync(manifest(s));
};
const broken = async (s: Box) => {
  await own(s);
  fs.writeFileSync(s.credentials, "{");
};
/** A second saved credential for the same project identity, written straight into the file. */
const two = (change: Partial<CredentialEntry>) => async (s: Box) => {
  await own(s);
  const id = "bbbbbbbbbbbbbbbb";
  const file = JSON.parse(fs.readFileSync(s.credentials, "utf8")) as {
    entries: object;
  };
  const second = fx.entry(NOW, {
    id,
    token: fx.tokenFor(id, "P".repeat(43)),
    ...change,
  });
  Object.assign(file.entries, {
    [`${second.origin}|${second.identity}|${second.project}`]: second,
  });
  fs.writeFileSync(s.credentials, JSON.stringify(file));
};
const origins = two({ origin: fx.OTHER_ORIGIN });
const names = two({ project: "other" });
const extra = bad(JSON.stringify({ ...fx.bindingFor(), x: 1 }));
const login = "forge cloud login";
const refused: [string, (s: Box) => unknown, string, string?][] = [
  ["another identity", other, "INPUT_CONFLICT"],
  ["no manifest", gone, "CONTEXT_MISSING"],
  ["text that is not JSON", bad("nope"), "INPUT_INVALID"],
  ["an extra key", extra, "INPUT_INVALID"],
  ["a live credential, no binding", own, "INPUT_CONFLICT", login],
  ["an expired credential, no binding", lapse, "INPUT_CONFLICT", login],
  ["credentials for two origins", origins, "INPUT_CONFLICT"],
  ["credentials for two project names", names, "INPUT_CONFLICT"],
  ["an unreadable credential store", broken, "ACCOUNT_INTEGRITY"],
];
const link = (s: Box) => fs.symlinkSync(manifest(s), s.binding);
if (process.platform !== "win32")
  refused.push(["a symlink", link, "INPUT_INVALID"]);
for (const [name, setup, code, hint] of refused)
  test(`${name} is refused, writes nothing and echoes no token`, () =>
    boxed(async (s) => {
      await setup(s);
      const before = tree(s.dir);
      const got = refusal(() => cloudBinding(s.root, s.home));
      expect([name, got?.code]).toEqual([name, code]);
      if (hint !== undefined) expect(got?.message).toContain(hint);
      expect(got?.message).not.toContain(OWN_TOKEN);
      expect(tree(s.dir)).toEqual(before);
    }));

test("the repository gitignore tracks the binding and still ignores other local .forge files", () => {
  const ignored = (path: string) =>
    git(
      resolve(import.meta.dirname, "../.."),
      "check-ignore",
      "-q",
      "--no-index",
      "--",
      path,
    );
  expect(ignored(".forge/cloud.json")).toBe(1);
  expect(ignored(".forge/scratch.json")).toBe(0);
  expect(ignored(".forge/state.sqlite")).toBe(0);
});
