// [integration] Real child owns a descendant holding a fixture file and private pipes.
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
  // Keep release attached to a live parent that reaps its descendant through close.
  // Private pipes prevent the descendant from holding the fixture's pipe handles.
  const source = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['pipe','pipe','pipe']}); process.stdin.pipe(c.stdin); c.stdout.pipe(process.stdout); c.stderr.pipe(process.stderr); c.once('close',code=>{process.stdin.destroy();process.exitCode=code??1});`;
  const child = spawn(Bun.which("node")!, ["-e", source], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
  owner.own(child, () => child.stdin.end("release"));
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
    await pending;
    expect(removed).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(child.stdout.closed).toBe(true);
    expect(child.stderr.closed).toBe(true);
    expect(existsSync(root)).toBe(false);
  } finally {
    if (!child.stdin.writableEnded) child.stdin.end("release");
    await closed;
    await pending?.catch(() => {});
    if (existsSync(root)) rmSync(root, { recursive: true });
  }
}, 15_000);
