import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { dispatch, record } from "../../src/surface/dispatch.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import {
  ApprovalRequired,
  ownerApproval,
  consumeOwnerApproval,
} from "../../src/assembly/approval.ts";
import { TrustStore } from "../../src/core/trust/index.ts";
import { memoryState } from "../blocks/memory/lib.ts";

function pending(result: ResultEnvelope): string {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "APPROVAL_REQUIRED" },
  });
  const request = record(record(result.result)?.request);
  expect(request?.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(typeof request?.ask).toBe("string");
  expect(request?.binding).toMatch(/^sha256:[a-f0-9]{64}$/);
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
  const manifestPath = join(root, "hello/forge.block.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    id: string;
    operations: Record<string, { effects: string[] }>;
  };
  manifest.operations["hello.say"]!.effects = ["hello:write"];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  cpSync(join(root, "hello"), join(root, "other"), { recursive: true });
  writeFileSync(
    join(root, "other/forge.block.json"),
    JSON.stringify({ ...manifest, id: "example.org/other" }).replaceAll(
      "hello.say",
      "other.say",
    ),
  );
  for (const file of ["docs.json", "index.cjs"]) {
    const path = join(root, "other", file);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll("hello.say", "other.say"),
    );
  }
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
    const other = await call("block.add", { path: "./other" });
    expect(other).toMatchObject({ ok: true });
    const otherDigest = String(record(other.result)?.digest);
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
        digest: otherDigest,
        approval,
      }),
    ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
    expect(await call("block.admit", { digest, approval })).toMatchObject({
      ok: true,
      result: { admitted: true },
    });
    expect(await call("hello.say", { name: "Owner" })).toMatchObject({
      ok: false,
      error: { code: "GRANT_REQUIRED" },
    });
    const grant = pending(
      await call("config.grant", { digest, effects: ["hello:write"] }),
    );
    const grantApproval = { ...approval, request: grant };
    expect(
      await call("config.grant", {
        digest,
        effects: [],
        approval: grantApproval,
      }),
    ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
    expect(
      await call("config.grant", {
        digest,
        effects: ["hello:write"],
        approval: grantApproval,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await call("config.grant", {
        digest,
        effects: ["hello:write"],
        approval: grantApproval,
      }),
    ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
    expect(await call("other.say", { name: "Owner" })).toMatchObject({
      ok: false,
      error: { code: "ADMISSION_REQUIRED" },
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

test("expired requests, forged proofs and crashes cannot authorize or replay a trust write", () => {
  let now = 0;
  const state = memoryState();
  const options = {
    state,
    op: "block.admit",
    input: { digest: "fixture" },
    deviceRoot: "device",
    projectRoot: "project",
    ask: "Admit fixture?",
    relay: { harness: "codex", id: "chat", pid: 1 },
    now: () => now,
  };
  const issue = () => {
    try {
      ownerApproval(options);
    } catch (error) {
      if (error instanceof ApprovalRequired && error.request)
        return error.request.id;
      throw error;
    }
    throw Error("Expected approval request");
  };
  const retry = (request: string) =>
    ownerApproval({
      ...options,
      input: {
        digest: "fixture",
        approval: {
          request,
          quote: "yes",
          source: { harness: "codex", thread: "chat" },
        },
      },
    });
  const expired = issue();
  now = 24 * 60 * 60 * 1000;
  expect(() => retry(expired)).toThrow("APPROVAL_REQUIRED");
  const request = issue();
  const proof = retry(request);
  const trust = new TrustStore(
    {
      get: () => undefined,
      set: () => {
        throw Error("injected crash");
      },
      delete: () => {},
    },
    consumeOwnerApproval,
  );
  expect(() =>
    trust.admit({} as Parameters<typeof trust.admit>[0], "fixture"),
  ).toThrow("APPROVAL_REQUIRED");
  expect(() => trust.admit(proof, "other")).toThrow("APPROVAL_REQUIRED");
  expect(() => trust.admit(proof, "fixture")).toThrow("injected crash");
  expect(() => retry(request)).toThrow("APPROVAL_REQUIRED");
  expect(() => trust.admit(proof, "fixture")).toThrow("APPROVAL_REQUIRED");
  expect(state.get(request)?.value).toMatchObject({
    status: "used",
    method: "relayed",
    quote: { kind: "untrusted", text: "yes" },
    source: { harness: "codex", thread: "chat" },
  });
}, 30_000);

test("store recovery requires a chat request, quote and source", async () => {
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
