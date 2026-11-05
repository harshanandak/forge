// [integration] Real child and descendant retain fixture files and inherited pipes.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureChildren } from "./fixture-children.ts";

test("fixture cleanup waits for its owned child and descendant stream before removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-owned-child-"));
  const owner = new FixtureChildren();
  const descendant = `const fs=require('node:fs'); const fd=fs.openSync('held.txt','w'); process.stdout.write('ready'); process.stdin.once('data',()=>{fs.closeSync(fd);process.exit(0)});`;
  const source = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['inherit','inherit','inherit']}); c.unref(); process.exit(0);`;
  const child = owner.own(
    spawn(Bun.which("node")!, ["-e", source], {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    }),
  );
  const closed = once(child, "close");
  let removed = false;
  let pending: Promise<void> | undefined;
  try {
    await once(child.stdout, "data");
    pending = owner.cleanup(() => {
      removed = true;
      rmSync(root, { recursive: true });
    });
    // Observe rejection now as well: Windows may refuse to remove the open file.
    void pending.catch(() => {});
    await Promise.resolve();
    expect(removed).toBe(false);
    expect(existsSync(root)).toBe(true);
    child.stdin.end("release");
    await pending;
    expect(removed).toBe(true);
    expect(child.stdout.closed).toBe(true);
    expect(existsSync(root)).toBe(false);
  } finally {
    child.stdin.end("release");
    await closed;
    await pending?.catch(() => {});
    if (existsSync(root)) rmSync(root, { recursive: true });
  }
}, 15_000);
