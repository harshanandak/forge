// [integration] Real child owns a descendant holding a fixture file and private pipes.
import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureChildren } from "./fixture-children.ts";
import * as windowsJobs from "../src/adapters/process/windows-job.ts";

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (process.platform === "win32") {
  test("fixture cleanup deadline names the live descendant when forced termination stalls", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-stalled-cleanup-"));
    const owner = new FixtureChildren();
    const openJob = windowsJobs.openWindowsJob;
    let job: windowsJobs.WindowsJob | undefined;
    let finishStop: (() => void) | undefined;
    const forcedStop = spyOn(windowsJobs, "openWindowsJob").mockImplementation(
      (options) => {
        job = openJob(options);
        return {
          ...job,
          stop: () =>
            new Promise<readonly number[]>((resolve) => {
              finishStop = () => resolve([]);
            }),
        };
      },
    );
    const descendant = `const fs=require('node:fs'); const fd=fs.openSync('held.txt','w'); const watcher=fs.watch('.',()=>{if(fs.existsSync('release')){watcher.close();fs.closeSync(fd);process.exit(0)}}); process.stdout.write(JSON.stringify({pid:process.pid}));`;
    const source = `process.stdin.once('data',()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore',1,2]});c.unref();process.stdin.destroy()});`;
    let child: ReturnType<FixtureChildren["spawn"]> | undefined;
    let closed: Promise<unknown> | undefined;
    let pending: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let descendantPid: number | undefined;
    let removed = false;
    try {
      child = owner.spawn(Bun.which("node")!, ["-e", source], {
        cwd: root,
        windowsHide: true,
      });
      const exited = once(child, "exit");
      closed = once(child, "close");
      const ready = once(child.stdout, "data");
      child.stdin.end("start");
      const [data] = (await ready) as unknown[];
      descendantPid = (JSON.parse(String(data)) as { pid: number }).pid;
      await exited;
      expect(alive(descendantPid)).toBe(true);
      expect(child.stdout.closed).toBe(false);
      const started = performance.now();
      pending = owner.cleanup(() => {
        removed = true;
      });
      const bounded = Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("cleanup had no internal deadline")),
            3_000,
          );
        }),
      ]);
      await expect(bounded).rejects.toThrow("Fixture cleanup deadline");
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(2_500);
      expect(finishStop).toBeDefined();
      expect(alive(descendantPid)).toBe(true);
      expect(child.stdout.closed).toBe(false);
      expect(child.stderr.closed).toBe(false);
      expect(removed).toBe(false);
      expect(existsSync(join(root, "held.txt"))).toBe(true);
      await expect(pending).rejects.toThrow(`live members: ${descendantPid}`);
      await expect(pending).rejects.toThrow("stdout");
      await expect(pending).rejects.toThrow("stderr");
    } finally {
      clearTimeout(timer);
      forcedStop.mockRestore();
      if (existsSync(root)) writeFileSync(join(root, "release"), "release");
      await job?.stop();
      finishStop?.();
      job?.close();
      if (descendantPid && alive(descendantPid))
        process.kill(descendantPid, "SIGKILL");
      if (child && child.exitCode === null) child.kill("SIGKILL");
      await closed;
      await pending?.catch(() => {});
      if (existsSync(root)) rmSync(root, { recursive: true });
    }
  }, 10_000);

  test("fixture cleanup ends an orphan holding a file and inherited pipe after its leader exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-orphan-child-"));
    const owner = new FixtureChildren();
    const descendant = `const fs=require('node:fs'); const fd=fs.openSync('held.txt','w'); const watcher=fs.watch('.',()=>{if(fs.existsSync('release')){watcher.close();fs.closeSync(fd);process.exit(0)}}); process.stdout.write(JSON.stringify({pid:process.pid}));`;
    // Gate the fork until ownership is installed, then let the leader exit first.
    const source = `process.stdin.once('data',()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore',1,2]});c.unref();process.stdin.destroy()});`;
    const child = owner.spawn(Bun.which("node")!, ["-e", source], {
      cwd: root,
      windowsHide: true,
    });
    const exited = once(child, "exit");
    const closed = once(child, "close");
    const ready = once(child.stdout, "data");
    let descendantPid: number | undefined;
    let pending: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child.stdin.end("start");
      const [data] = (await ready) as unknown[];
      descendantPid = (JSON.parse(String(data)) as { pid: number }).pid;
      await exited;
      expect(alive(descendantPid)).toBe(true);
      expect(child.stdout.closed).toBe(false);
      pending = owner.cleanup(() => rmSync(root, { recursive: true }));
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("orphan cleanup did not finish")),
            3_000,
          );
        }),
      ]);
      expect(alive(descendantPid)).toBe(false);
      expect(child.stdout.closed).toBe(true);
      expect(child.stderr.closed).toBe(true);
      expect(existsSync(root)).toBe(false);
    } finally {
      clearTimeout(timer);
      if (existsSync(root)) writeFileSync(join(root, "release"), "release");
      if (descendantPid && alive(descendantPid))
        process.kill(descendantPid, "SIGKILL");
      if (child.exitCode === null) child.kill("SIGKILL");
      await closed;
      await pending?.catch(() => {});
      if (existsSync(root)) rmSync(root, { recursive: true });
    }
  }, 10_000);
}

test("fixture cleanup bounds ignored shutdown and names the child and open streams", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-ignored-shutdown-"));
  const owner = new FixtureChildren();
  const child = spawn(
    Bun.which("node")!,
    ["-e", "process.stdin.on('data',()=>{});process.stdout.write('ready');"],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  owner.own(child, () => child.stdin.write("ignored"));
  const closed = once(child, "close");
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removed = false;
  try {
    await once(child.stdout, "data");
    const started = performance.now();
    pending = owner.cleanup(() => {
      removed = true;
      rmSync(root, { recursive: true });
    });
    const bounded = Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("cleanup had no internal deadline")),
          3_000,
        );
      }),
    ]);
    await expect(bounded).rejects.toThrow(
      `Fixture cleanup deadline: PID ${child.pid}`,
    );
    await expect(pending).rejects.toThrow("stdout");
    await expect(pending).rejects.toThrow("stderr");
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(removed).toBe(false);
    expect(existsSync(root)).toBe(true);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed;
    await pending?.catch(() => {});
    if (existsSync(root)) rmSync(root, { recursive: true });
  }
}, 10_000);

test("fixture command capture preserves output, exit status and spawn errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-command-capture-"));
  const owner = new FixtureChildren();
  try {
    const result = await owner.run(
      Bun.which("node")!,
      [
        "-e",
        "process.stdout.write('out');process.stderr.write('err');process.exitCode=7;",
      ],
      { cwd: root, windowsHide: true },
    );
    expect(result).toEqual({
      status: 7,
      stdout: "out",
      stderr: "err",
      error: undefined,
    });
    const missing = await owner.run(join(root, "missing-command"), [], {
      cwd: root,
      windowsHide: true,
    });
    expect(missing.error).toBeInstanceOf(Error);
    expect((missing.error as NodeJS.ErrnoException).code).toBe("ENOENT");
  } finally {
    await owner.cleanup(() => rmSync(root, { recursive: true }));
  }
  expect(existsSync(root)).toBe(false);
}, 10_000);
