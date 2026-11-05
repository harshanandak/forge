// [integration] Real child owns a descendant holding a fixture file and private pipes.
import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // An adopted Linux zombie has terminated and holds no files or pipe handles.
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch {
    return false;
  }
}

test("fixture cleanup ends an orphan holding a file and inherited pipe after its leader exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-orphan-child-"));
  const owner = new FixtureChildren();
  const descendant = `const fs=require('node:fs'); const fd=fs.openSync('held.txt','w'); const watcher=fs.watch('.',()=>{if(fs.existsSync('release')){watcher.close();fs.closeSync(fd);process.exit(0)}}); process.stdout.write(JSON.stringify({pid:process.pid}));`;
  // Gate the fork until ownership is installed, then let the leader exit first.
  const source = `process.stdin.once('data',()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:process.platform==='win32',stdio:['ignore',1,2]});c.unref();process.stdin.destroy()});`;
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

test("fixture cleanup bounds ignored shutdown and names the child and open streams", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-ignored-shutdown-"));
  const owner = new FixtureChildren();
  const child = spawn(
    Bun.which("node")!,
    ["-e", "process.stdin.on('data',()=>{});process.stdout.write('ready');"],
    {
      cwd: root,
      windowsHide: true,
      detached: process.platform !== "win32",
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

if (process.platform !== "win32") {
  test("fixture cleanup forgets an empty process group and leaves a later sibling alive", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-stale-group-"));
    const owner = new FixtureChildren();
    const leader = owner.spawn(Bun.which("node")!, ["-e", ""], { cwd: root });
    leader.stdin.end();
    await once(leader, "close");
    expect(() => process.kill(-leader.pid!, 0)).toThrow();
    const sibling = spawn(
      Bun.which("node")!,
      ["-e", "setInterval(()=>{},1000);process.stdout.write('ready');"],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const siblingClosed = once(sibling, "close");
    const kill = process.kill.bind(process);
    let signalledStaleGroup = false;
    let probe: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
    try {
      await once(sibling.stdout, "data");
      probe = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -leader.pid! && signal !== 0) signalledStaleGroup = true;
        return kill(pid, signal);
      });
      await owner.cleanup(() => rmSync(root, { recursive: true }));
      expect(signalledStaleGroup).toBe(false);
      expect(alive(sibling.pid!)).toBe(true);
      expect(existsSync(root)).toBe(false);
    } finally {
      probe?.mockRestore();
      sibling.kill("SIGKILL");
      await siblingClosed;
      if (existsSync(root)) rmSync(root, { recursive: true });
    }
  }, 10_000);
}
