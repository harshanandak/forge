import { test, expect, spyOn } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssemblyProviders,
  processCleanupBudgetMs,
  SNAPSHOT_TIMEOUT_MS,
  SNAPSHOT_OPERATION_TIMEOUT_MS,
} from "../../../src/assembly/providers.ts";
import type { ProcessPort, ProcessResult } from "../../../src/ports/process.ts";
import type { ServiceScope } from "../../../src/core/runtime/index.ts";
import { fixture } from "../../core/async-handlers/fixture.ts";

test("a snapshot refusal reaches the handler immediately, before its operation deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "snapshot-refusal-"));
  const git = join(root, ".git");
  mkdirSync(git);
  const port: ProcessPort = {
    capability: "forge.process/v1",
    resolve: () => ({ kind: "resolved", path: "git" }),
    run: () => Promise.resolve(result(`${git}\n${git}\n`)),
  };
  const f = fixture(
    `({ services }) => services.files.snapshot({ paths: ['missing'], maxBytes: 100, timeoutMs: 5000, maxOutputBytes: 66 })`,
    { effects: ["files:read"], timeoutMs: 2000 },
  );
  f.trust.grant("human", f.block.digest, ["files:read"]);
  try {
    const started = performance.now();
    const response = await f
      .runtime({
        services: async (_instance, _context, scope) => {
          const lease = await createAssemblyProviders(
            root,
            { env: {} },
            port,
          ).openFiles(scope);
          return { ...lease, value: { files: lease.value } };
        },
      })
      .invoke(f.request);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "INVOCATION_TIMEOUT",
        message: "Snapshot has no time left for Git and cleanup",
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);

const result = (stdout: string): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: "",
  timedOut: false,
  truncated: false,
  durationMs: 0,
});
test("missing-path snapshots preserve typed input failures well under 1 s", async () => {
  const root = mkdtempSync(join(tmpdir(), "snapshot-missing-"));
  const git = join(root, ".git");
  mkdirSync(git);
  const port: ProcessPort = {
    capability: "forge.process/v1",
    resolve: () => ({ kind: "resolved", path: "git" }),
    run: (_program, args) =>
      Promise.resolve(
        result(
          args.includes("--absolute-git-dir")
            ? `${git}\n${git}\n`
            : "a".repeat(40),
        ),
      ),
  };
  const lease = await createAssemblyProviders(
    root,
    { env: {} },
    port,
  ).openFiles({
    op: "provider.snapshot",
    effects: ["files:read"],
    signal: new AbortController().signal,
    deadline: Date.now() + SNAPSHOT_OPERATION_TIMEOUT_MS,
    processContainment: "supervised",
  });
  const input = {
    paths: ["missing"],
    maxBytes: 100,
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    maxOutputBytes: 66,
  };
  try {
    const started = performance.now();
    const failure = await lease.value
      .snapshot({ ...input, maxBytes: 0 })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ error: { code: "INPUT_INVALID" } });
    expect(await lease.value.snapshot(input)).toMatchObject({
      head: "a".repeat(40),
    });
    expect(performance.now() - started).toBeLessThan(1000);
  } finally {
    await lease.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);
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
      {
        env: {},
        supervision: {
          cleanupTimeoutMs: 100,
          pollIntervalMs: 25,
          drainTimeoutMs: 50,
          maxConcurrent: 1,
        },
      },
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

test("snapshots cap long caller budgets and reject a late final HEAD", async () => {
  const root = mkdtempSync(join(tmpdir(), "snapshot-budget-"));
  const git = join(root, ".git");
  mkdirSync(git);
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let heads = 0;
  let late = false;
  let slow = false;
  const port: ProcessPort = {
    capability: "forge.process/v1",
    resolve: () => ({ kind: "resolved", path: "git" }),
    run(_program, args, options) {
      if (args.includes("--absolute-git-dir"))
        return Promise.resolve(result(`${git}\n${git}\n`));
      heads++;
      expect(options.timeoutMs).toBeLessThanOrEqual(
        SNAPSHOT_TIMEOUT_MS - processCleanupBudgetMs(),
      );
      const elapsed =
        late && heads % 2 === 0 ? SNAPSHOT_TIMEOUT_MS : slow ? 6000 : 100;
      now += elapsed;
      return Promise.resolve({
        ...result("a".repeat(40)),
        timedOut: !late && elapsed > options.timeoutMs,
      });
    },
  };
  let lease;
  try {
    lease = await createAssemblyProviders(root, { env: {} }, port).openFiles({
      op: "sample.read",
      effects: ["files:read"],
      signal: new AbortController().signal,
      deadline: now + 600000,
      processContainment: "supervised",
    });
    const input = {
      paths: [],
      maxBytes: 100,
      timeoutMs: 600000,
      maxOutputBytes: 66,
    };
    expect(await lease.value.snapshot(input)).toMatchObject({
      head: "a".repeat(40),
    });
    slow = true;
    expect(await lease.value.snapshot(input)).toMatchObject({
      head: "a".repeat(40),
    });
    late = true;
    const failure = await lease.value
      .snapshot(input)
      .catch((error: unknown) => error);
    expect(String(failure)).toContain("Snapshot deadline exceeded");
    expect(heads).toBe(6);
  } finally {
    clock.mockRestore();
    await lease?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);
