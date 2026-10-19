import { expect, setDefaultTimeout, test } from "bun:test";
import {
  createAssemblyProviders,
  assemblyProvides,
} from "../../../src/assembly/providers.ts";
import type { ProcessPort, ProcessResult } from "../../../src/ports/process.ts";
import { result } from "../process/fake-process.ts";

setDefaultTimeout(5000);
for (const kind of ["repository", "account"] as const) {
  test(`${kind} binding enforces effects, handler deadline and cancellation`, async () => {
    let launches = 0;
    const controller = new AbortController();
    const process: ProcessPort = {
      capability: "forge.process/v1",
      resolve: () => ({ kind: "resolved", path: "/tool" }),
      run(_program, _args, options) {
        launches++;
        expect(options.timeoutMs).toBeLessThanOrEqual(1000);
        expect(options.containment).toBe("supervised");
        expect(options.signal).toBeDefined();
        return Promise.resolve(result());
      },
    };
    const providers = createAssemblyProviders("/project", { env: {} }, process);
    const scope = {
      op: "sample.run",
      effects: [] as string[],
      signal: controller.signal,
      deadline: Date.now() + 1000,
      processContainment: "supervised" as const,
    };
    const readonly = await providers[kind](scope);
    const options = {
      cwd: "/project",
      env: {},
      timeoutMs: 60_000,
      maxOutputBytes: 100,
    };
    expect(
      await readonly.value
        .run("configured-tool", [], options)
        .catch((error: unknown) => error),
    ).toMatchObject({ error: { code: "EFFECT_UNDECLARED" } });
    expect(launches).toBe(0);
    await readonly.close();
    const owned = await providers[kind]({
      ...scope,
      effects: ["external:process"],
    });
    await owned.value.run("configured-tool", [], options);
    expect(launches).toBe(1);
    await owned.close();
    expect(() => owned.value.resolve("configured-tool", {})).toThrow(
      /SERVICE_EXPIRED/,
    );
    const expired = { ...scope, deadline: Date.now() - 1 };
    expect(
      await providers[kind](expired).catch((error: unknown) => error),
    ).toMatchObject({ error: { code: "INVOCATION_TIMEOUT" } });
  });

  test(`${kind} owned close aborts and drains an unawaited native command`, async () => {
    let finish: ((value: ProcessResult) => void) | undefined;
    let childSignal: AbortSignal | undefined;
    const process: ProcessPort = {
      capability: "forge.process/v1",
      resolve: () => ({ kind: "resolved", path: "/tool" }),
      run(_program, _args, options) {
        childSignal = options.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    };
    const providers = createAssemblyProviders("/project", { env: {} }, process);
    const scope = {
      op: "sample.run",
      effects: ["external:process"],
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      processContainment: "supervised" as const,
    };
    const lease = await providers[kind](scope);
    const pending = lease.value.run("tool", [], {
      cwd: "/project",
      env: {},
      timeoutMs: 60_000,
      maxOutputBytes: 100,
    });
    let closed = false;
    const closing = lease.close().then(() => {
      closed = true;
    });
    expect(childSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(closed).toBe(false);
    if (finish === undefined) throw new Error("Command was not launched");
    finish(result());
    await closing;
    await pending;
    expect(closed).toBe(true);
  });

  test(`${kind} strict containment refuses an unavailable host before any resolution or launch`, async () => {
    let calls = 0;
    const process: ProcessPort = {
      capability: "forge.process/v1",
      containment: () =>
        Promise.resolve({
          available: false,
          reason: "unavailable native containment",
        }),
      resolve() {
        calls++;
        return { kind: "resolved", path: "/tool" };
      },
      run() {
        calls++;
        return Promise.resolve(result());
      },
    };
    const providers = createAssemblyProviders("/project", { env: {} }, process);
    const scope = {
      op: "sample.run",
      effects: ["external:process"],
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      processContainment: "strict" as const,
    };
    expect(
      await providers[kind](scope).catch((error: unknown) => error),
    ).toMatchObject({ error: { code: "CONTAINMENT_UNAVAILABLE" } });
    expect(calls).toBe(0);
  });
}
test("typed command interfaces are assembled at their declared versions", () => {
  expect(assemblyProvides("forge.vcs-command@1")).toBe(true);
  expect(assemblyProvides("forge.github-command@1")).toBe(true);
  expect(assemblyProvides("forge.github-command@2")).toBe(false);
});
