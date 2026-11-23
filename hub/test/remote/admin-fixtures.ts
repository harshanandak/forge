import { spyOn } from "bun:test";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { ProtectPath } from "../../src/contract/runtime.ts";
import { adminWith } from "../../src/remote/index.ts";
import { config, FakeHubCore } from "./fixtures.ts";

export async function capture(run: () => Promise<number>) {
  const text = { stdout: "", stderr: "" };
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    text.stdout += String(chunk);
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    text.stderr += String(chunk);
    return true;
  });
  try {
    const status = await run();
    return { status, ...text };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

export async function adminFixture(settings = config()) {
  const root = await mkdtemp(join(tmpdir(), "forge-admin-"));
  const core = new FakeHubCore(settings);
  const checks: Array<[string, "file" | "dir"]> = [];
  const sizes: number[] = [];
  const fixture = {
    root,
    core,
    checks,
    sizes,
    allowed: true,
    fileAllowed: true,
    reads: 0,
    stdin: "hello\n",
  };
  const protectPath: ProtectPath = (path, kind) => {
    checks.push([path, kind]);
    return fixture.allowed;
  };
  const paths = {
    async createPrivateDirectory(path: string) {
      await mkdir(path, { mode: 0o700 });
      return true;
    },
    async createPrivateFile(path: string): Promise<FileHandle | null> {
      const file = await open(path, "wx", 0o600);
      sizes.push((await file.stat()).size);
      if (fixture.fileAllowed) return file;
      await file.close();
      await rm(path);
      return null;
    },
  };
  return Object.assign(fixture, {
    exists: (path: string) =>
      lstat(path).then(
        () => true,
        () => false,
      ),
    run: (args: string[]) =>
      capture(() =>
        adminWith(
          args,
          {
            config: settings,
            core,
            protectPath,
            readStdin: () => {
              fixture.reads++;
              return Promise.resolve(fixture.stdin);
            },
          },
          paths,
        ),
      ),
    close: () => rm(root, { recursive: true, force: true }),
  });
}
