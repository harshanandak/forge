import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutScopeRoot } from "../../../src/adapters/vcs-git/index.ts";
import { fakeProcess } from "../process/fake-process.ts";

const roots: string[] = [];
const base = { env: {}, timeoutMs: 1000, maxOutputBytes: 1000 };
function fixture(): string {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-checkout-scope-")),
  );
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("checkout scope is undefined outside git without starting a process", async () => {
  const root = fixture();
  const process = fakeProcess(["git"]);
  expect(await checkoutScopeRoot(root, { ...base, process })).toBeUndefined();
  expect(process.runs).toHaveLength(0);
}, 30_000);

test("checkout scope uses the nearest repository root from nested folders", async () => {
  const root = fixture();
  const checkout = join(root, "outer", "inner");
  const nested = join(checkout, "src", "nested");
  mkdirSync(join(root, "outer", ".git"), { recursive: true });
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  const process = fakeProcess(["git"]);
  expect(await checkoutScopeRoot(nested, { ...base, process })).toBe(checkout);
  expect(process.runs).toHaveLength(0);
}, 30_000);

test("checkout scope maps nested linked worktrees to their shared checkout root", async () => {
  const root = fixture();
  const main = join(root, "main");
  const linked = join(root, "linked");
  const nested = join(linked, "src", "nested");
  mkdirSync(join(main, ".git", "worktrees", "linked"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(linked, ".git"), "gitdir: unused\n");
  const process = fakeProcess(["git"], () => ({
    stdout: `${linked}\n${join(main, ".git", "worktrees", "linked")}\n${join(main, ".git")}\n`,
  }));
  expect(await checkoutScopeRoot(nested, { ...base, process })).toBe(main);
  expect(process.runs[0]?.options.cwd).toBe(linked);
}, 30_000);
