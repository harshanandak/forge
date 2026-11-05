import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { dispatch, record } from "../../src/surface/dispatch.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";

function pending(result: ResultEnvelope): string {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "APPROVAL_REQUIRED" },
    result: {
      request: {
        id: expect.any(String),
        ask: expect.any(String),
        binding: expect.any(String),
      },
    },
  });
  const request = record(record(result.result)?.request);
  return String(request?.id);
}

test("an agent's local block admission needs a single-use chat reply bound to its arguments", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-owner-approval-"));
  const root = join(work, "project");
  mkdirSync(root);
  cpSync(
    resolve(import.meta.dirname, "../../examples/hello-block"),
    join(root, "hello"),
    { recursive: true },
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(work, "device"),
  });
  const options = localCall(assembly);
  const call = (op: string, input: unknown) =>
    dispatch(assembly.catalog, op, input, options);
  try {
    const added = await call("block.add", { path: "./hello" });
    expect(added.ok).toBe(true);
    const digest = String(record(added.result)?.digest);
    const request = pending(await call("block.admit", { digest }));
    expect(await call("hello.say", { name: "Owner" })).toMatchObject({
      ok: false,
      error: { code: "ADMISSION_REQUIRED" },
    });
    expect(
      await call("block.admit", { digest, approval: { by: "owner" } }),
    ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
    const approval = {
      request,
      quote: "yes",
      source: { harness: "codex", thread: "owner-chat", message: "reply-1" },
    };
    expect(
      await call("block.admit", {
        digest: `sha256:${"b".repeat(64)}`,
        approval,
      }),
    ).toMatchObject({ ok: false });
    expect(await call("block.admit", { digest, approval })).toMatchObject({
      ok: true,
      result: { admitted: true },
    });
    expect(await call("block.admit", { digest, approval })).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_REQUIRED" },
    });
    expect(await call("hello.say", { name: "Owner" })).toMatchObject({
      ok: true,
    });
  } finally {
    await assembly.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 30_000);

test("effect grants and store recovery also require a chat request, quote and source", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-owner-other-"));
  const assembly = await createAssembly({
    root: work,
    deviceRoot: join(work, "device"),
    project: true,
  });
  const options = localCall(assembly);
  const call = (op: string, input: unknown) =>
    dispatch(assembly.catalog, op, input, options);
  try {
    const request = pending(await call("store.reinit", {}));
    for (const approval of [
      { by: "owner" },
      { request, quote: "yes" },
      { request, quote: " ", source: { harness: "codex", thread: "chat" } },
    ]) {
      expect(await call("store.reinit", { approval })).toMatchObject({
        ok: false,
        error: { code: "APPROVAL_REQUIRED" },
      });
    }
    expect(
      await call("store.reinit", {
        approval: {
          request,
          quote: "yes",
          source: { harness: "codex", thread: "chat" },
        },
      }),
    ).toMatchObject({ ok: true });
  } finally {
    await assembly.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 30_000);
