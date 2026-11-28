import { spyOn, test } from "bun:test";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { adminWith } from "../../src/remote/index.ts";
import { hubTestTemp } from "../temp.ts";
import { config, fakeCore, safeOutput } from "./fixtures.ts";

async function capture(run: () => Promise<number>) {
  const text = { stdout: "", stderr: "" };
  const watch = (stream: keyof typeof text) =>
    spyOn(process[stream], "write").mockImplementation((chunk) => {
      text[stream] += String(chunk);
      return true;
    });
  const out = watch("stdout");
  const err = watch("stderr");
  try {
    return { status: await run(), ...text };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

async function fixture(settings: ReturnType<typeof config>) {
  const root = await realpath(hubTestTemp("forge-admin-"));
  const core = fakeCore(settings);
  const checks: Array<[string, "file" | "dir"]> = [];
  const sizes: number[] = [];
  const state = {
    allowed: true,
    fileAllowed: true,
    reads: 0,
    stdin: "hello\n",
  };
  return {
    root,
    core,
    checks,
    sizes,
    state,
    path: (name: string) => join(root, name),
    exists: (path: string) =>
      lstat(path).then(
        () => true,
        () => false,
      ),
    close: () => rm(root, { recursive: true, force: true }),
    async run(args: string[]) {
      const result = await capture(() =>
        adminWith(
          args,
          {
            config: settings,
            core,
            protectPath(path, kind) {
              checks.push([path, kind]);
              return state.allowed;
            },
            readStdin() {
              state.reads++;
              return Promise.resolve(state.stdin);
            },
          },
          {
            async createPrivateDirectory(path) {
              await mkdir(path, { mode: 0o700 });
              return true;
            },
            async createPrivateFile(path) {
              const file = await open(path, "wx", 0o600);
              sizes.push((await file.stat()).size);
              if (state.fileAllowed) return file;
              await file.close();
              await rm(path);
              return null;
            },
          },
        ),
      );
      safeOutput(result.stdout + result.stderr);
      return result;
    },
  };
}

export const adminTest =
  (timeout: number) =>
  (
    name: string,
    run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
    settings = config(),
  ) =>
    test(
      name,
      async () => {
        const f = await fixture(settings);
        try {
          await run(f);
        } finally {
          await f.close();
        }
      },
      timeout,
    );
