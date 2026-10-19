import { test, expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssemblyProviders } from "../../../src/assembly/providers.ts";
import type { ProcessPort, ProcessResult } from "../../../src/ports/process.ts";
import type { ServiceScope } from "../../../src/core/runtime/index.ts";

const result = (stdout: string): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: "",
  timedOut: false,
  truncated: false,
  durationMs: 0,
});
test("strict clone-file discovery refuses before launching on an unavailable host", async () => {
  let launches = 0;
  const port: ProcessPort = {
    capability: "forge.process/v1",
    containment: () => Promise.resolve({ available: false, reason: "fixture" }),
    resolve: () => ({ kind: "resolved", path: "git" }),
    run: () => {
      launches++;
      return Promise.resolve(result(""));
    },
  };
  const providers = createAssemblyProviders("/project", { env: {} }, port);
  const error = await providers
    .openFiles({
      op: "sample.read",
      effects: ["files:read"],
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      processContainment: "strict",
    })
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ error: { code: "CONTAINMENT_UNAVAILABLE" } });
  expect(launches).toBe(0);
}, 5000);

test("clone-file methods follow the current handler deadline and drain an unawaited snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-lifetime-"));
  const git = join(root, ".git");
  mkdirSync(git);
  writeFileSync(join(root, "input"), "data");
  let deadline = Date.now() + 10000;
  let stopped = false;
  const port: ProcessPort = {
    capability: "forge.process/v1",
    resolve: () => ({ kind: "resolved", path: "git" }),
    run(_program, args, options) {
      expect(options.containment).toBe("supervised");
      if (args.includes("--absolute-git-dir"))
        return Promise.resolve(result(`${git}\n${git}\n`));
      return new Promise((resolve) => {
        const stop = () => {
          stopped = true;
          resolve({ ...result(""), timedOut: true });
        };
        if (options.signal?.aborted) stop();
        else options.signal?.addEventListener("abort", stop, { once: true });
      });
    },
  };
  const scope: ServiceScope = {
    op: "sample.read",
    effects: ["files:read", "files:write"],
    signal: new AbortController().signal,
    get deadline() {
      return deadline;
    },
    processContainment: "supervised",
  };
  try {
    const lease = await createAssemblyProviders(
      root,
      { env: {} },
      port,
    ).openFiles(scope);
    expect(lease.value.read("input", 10)).toBe("data");
    deadline = Date.now() - 1;
    expect(() => lease.value.read("input", 10)).toThrow("INVOCATION_TIMEOUT");
    deadline = Date.now() + 10000;
    const snapshot = lease.value
      .snapshot({
        paths: ["input"],
        maxBytes: 100,
        timeoutMs: 5000,
        maxOutputBytes: 100,
      })
      .catch((error: unknown) => error);
    lease.value.lock([join(git, "HEAD.lock")]);
    expect(existsSync(join(git, "HEAD.lock"))).toBe(true);
    await lease.close();
    expect(existsSync(join(git, "HEAD.lock"))).toBe(false);
    expect(stopped).toBe(true);
    expect(await snapshot).toMatchObject({
      error: { code: "INVOCATION_TIMEOUT" },
    });
    await lease.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);
