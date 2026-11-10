import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssemblyProviders } from "../../../src/assembly/providers.ts";
import type { ProcessPort } from "../../../src/ports/process.ts";

test("tracked snapshots retain exact dirty paths and refuse truncated Git output", async () => {
  const root = mkdtempSync(join(tmpdir(), "tracked-snapshot-"));
  const git = join(root, ".git");
  mkdirSync(git);
  const head = "a".repeat(40);
  let paths = ["staged.txt", "renamed\nfile.ts"];
  let truncated = false;
  const process: ProcessPort = {
    capability: "forge.process/v1",
    resolve: () => ({ kind: "resolved", path: "git" }),
    run(_program, args) {
      const diff = args.includes("diff");
      if (diff) expect(args).toContain(head);
      return Promise.resolve({
        exitCode: 0,
        signal: null,
        stderr: "",
        timedOut: false,
        truncated: diff && truncated,
        durationMs: 0,
        stdout: args.includes("--absolute-git-dir")
          ? `${git}\n${git}\n`
          : diff
            ? paths.map((path) => path + "\0").join("")
            : head,
      });
    },
  };
  const lease = await createAssemblyProviders(
    root,
    { env: {} },
    process,
  ).openFiles({
    op: "sample.snapshot",
    effects: ["files:read"],
    signal: new AbortController().signal,
    deadline: Date.now() + 30000,
    processContainment: "supervised",
  });
  const input = {
    tracked: true,
    paths: [],
    maxBytes: 100,
    timeoutMs: 10000,
    maxOutputBytes: 66,
  };
  try {
    expect((await lease.value.snapshot(input)).dirtyPaths).toEqual(
      [...paths].sort(),
    );
    paths = [];
    expect((await lease.value.snapshot(input)).dirtyPaths).toEqual([]);
    truncated = true;
    await expect(lease.value.snapshot(input)).rejects.toMatchObject({
      error: { code: "INPUT_CONFLICT" },
    });
  } finally {
    await lease.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 1000);
