import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { refuse } from "../../../src/core/trust/index.ts";

setDefaultTimeout(30_000);

const root = resolve(import.meta.dirname, "../../../src/blocks/work");
const namespace = "forge/work";
const actor = { kind: "agent", id: "fixture" } as const;
const session = { id: "fixture" } as const;
const sha = "0123456789abcdef0123456789abcdef01234567";
const longFiles = Array.from({ length: 1024 }, () => `src/${"a".repeat(486)}`);
const mediumFiles = Array.from(
  { length: 1024 },
  () => `src/${"a".repeat(452)}`,
);
const wideFiles = Array.from({ length: 256 }, () => `src/${"é".repeat(996)}`);
const globals = globalThis as Record<string, unknown>;
const hadFail = "fail" in globals;
const previousFail = globals.fail;
type Handler = (call: {
  input: Record<string, unknown>;
  config?: unknown;
  services: unknown;
}) => unknown;
let operations: Record<string, Handler>;

beforeAll(() => {
  globals.fail = refuse;
  operations = require(resolve(root, "entry.cts")) as typeof operations;
});
afterAll(() => {
  if (hadFail) globals.fail = previousFail;
  else delete globals.fail;
});

async function project() {
  const opened = await createSqliteStore(process.cwd()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const owner = new StateOwner(opened.handle.value, { now: () => 1000 });
  owner.initialize();
  let request = 0;
  const context = (op: string) => {
    if (op === "issue.claim")
      return {
        variant: "leased",
        leaseMode: "acquire",
        actor,
        session,
        project: { id: "test" },
      };
    if (["issue.update", "issue.close", "issue.release"].includes(op))
      return {
        variant: "leased",
        leaseMode: "held",
        actor,
        session,
        project: { id: "test" },
        leaseGeneration:
          owner.lease(namespace, "issue:work-1")?.generation ?? 1,
      };
    return { variant: "project", actor, project: { id: "test" } };
  };
  const call = async (op: string, input: Record<string, unknown>) => {
    const state = createStateClient({
      owner,
      namespace,
      write: true,
      requestId: `file-declarations-${++request}`,
      context: context(op) as never,
    });
    return await operations[op]!({
      input,
      config: { idPrefix: "forge" },
      services: { state },
    });
  };
  const refusal = async (op: string, input: Record<string, unknown>) => {
    try {
      await call(op, input);
    } catch (error) {
      expect(error).toBeInstanceOf(ForgeFailure);
      return (error as ForgeFailure).error;
    }
    throw new Error("Expected refusal");
  };
  return {
    owner,
    call,
    refusal,
    close: () => opened.handle.close(),
  };
}

test("create update show list and reopen preserve normalized file declarations", async () => {
  const p = await project();
  try {
    const created = (await p.call("issue.create", {
      title: "Files",
      expectedFiles: ["./src//alpha.ts", "src/./beta-?.ts", "**/*.rs"],
    })) as Record<string, unknown>;
    expect(created).toMatchObject({
      id: "forge-1",
      expectedFiles: ["src/alpha.ts", "src/beta-?.ts", "**/*.rs"],
    });
    expect(created).not.toHaveProperty("actualFiles");
    expect(created).not.toHaveProperty("filesAt");
    const listed = (await p.call("issue.list", {})) as {
      items: Record<string, unknown>[];
    };
    expect(listed.items[0]).toMatchObject({
      expectedFiles: ["src/alpha.ts", "src/beta-?.ts", "**/*.rs"],
    });
    await p.call("issue.claim", { id: "forge-1" });
    const updated = (await p.call("issue.update", {
      id: "forge-1",
      expectRevision: 1,
      expectedFiles: ["src/./delivered.ts", "docs//planned-*.ts"],
      actualFiles: ["src//delivered.ts"],
      filesAt: sha,
    })) as Record<string, unknown>;
    expect(updated).toMatchObject({
      expectedFiles: ["src/delivered.ts", "docs/planned-*.ts"],
      actualFiles: ["src/delivered.ts"],
      filesAt: sha,
    });
    await p.call("issue.close", {
      id: "forge-1",
      withoutReceipt: "done",
      reason: "finished",
    });
    await p.call("issue.release", { id: "forge-1" });
    await p.call("issue.claim", { id: "forge-1", reopen: "reopen" });
    expect(await p.call("issue.show", { id: "forge-1" })).toMatchObject({
      status: "open",
      expectedFiles: ["src/delivered.ts", "docs/planned-*.ts"],
      actualFiles: ["src/delivered.ts"],
      filesAt: sha,
    });
  } finally {
    await p.close();
  }
});

test("invalid declarations refuse create without a partial write", async () => {
  const p = await project();
  try {
    const before = JSON.stringify(p.owner.export());
    const long = `src/${"a".repeat(1020)}.ts`;
    const cases: unknown[] = [
      ["/src/a.ts"],
      ["C:/src/a.ts"],
      ["./C:/outside.ts"],
      ["../a.ts"],
      ["src\\a.ts"],
      ["!src/a.ts"],
      ["src/[ab].ts"],
      [long],
      Array.from({ length: 257 }, (_, index) => `src/${index}.ts`),
      [5],
    ];
    for (const expectedFiles of cases) {
      const error = await p.refusal("issue.create", {
        title: "Invalid",
        expectedFiles,
      });
      expect(error.code).toBe("INPUT_INVALID");
      expect(JSON.stringify(p.owner.export())).toBe(before);
    }
  } finally {
    await p.close();
  }
});

test("file declaration updates keep the revision and lease fence", async () => {
  const p = await project();
  try {
    await p.call("issue.create", {
      title: "Files",
      body: "x".repeat(65_536),
      expectedFiles: ["src/alpha.ts"],
    });
    await p.call("issue.claim", { id: "forge-1" });
    const stale = await p.refusal("issue.update", {
      id: "forge-1",
      expectRevision: 2,
      expectedFiles: ["src/beta.ts"],
    });
    expect(stale.code).toBe("REVISION_CONFLICT");
    expect(p.owner.get(namespace, "issue:work-1")?.value).toMatchObject({
      expectedFiles: ["src/alpha.ts"],
    });
    for (const patch of [
      { expectedFiles: ["src/[ab].ts"] },
      { actualFiles: Array.from({ length: 1025 }, (_, i) => `src/${i}.ts`) },
      { actualFiles: ["src/../outside.ts", "./D:/outside.ts"] },
      { filesAt: "not-a-sha" },
    ]) {
      const error = await p.refusal("issue.update", {
        id: "forge-1",
        expectRevision: 1,
        ...patch,
      });
      expect(error.code).toBe("INPUT_INVALID");
      expect(p.owner.get(namespace, "issue:work-1")?.value).toMatchObject({
        expectedFiles: ["src/alpha.ts"],
      });
    }
    await p.call("issue.update", {
      id: "forge-1",
      expectRevision: 1,
      expectedFiles: wideFiles,
    });
    await p.call("issue.update", {
      id: "forge-1",
      expectRevision: 2,
      actualFiles: mediumFiles,
    });
    const beforeLarge = p.owner.get(namespace, "issue:work-1")?.value;
    const large = await p.refusal("issue.update", {
      id: "forge-1",
      expectRevision: 3,
      actualFiles: longFiles,
    });
    expect(large.code).toBe("LIMIT_EXCEEDED");
    expect(p.owner.get(namespace, "issue:work-1")?.value).toEqual(beforeLarge);
    const close = await p.refusal("issue.close", {
      id: "forge-1",
      withoutReceipt: "c".repeat(2_000),
    });
    expect(close.code).toBe("LIMIT_EXCEEDED");
    expect(p.owner.get(namespace, "issue:work-1")?.value).toEqual(beforeLarge);
    await p.call("issue.release", { id: "forge-1" });
    const lost = await p.refusal("issue.update", {
      id: "forge-1",
      expectRevision: 1,
      expectedFiles: ["src/beta.ts"],
    });
    expect(["LEASE_NOT_HELD", "LEASE_STALE", "LEASE_EXPIRED"]).toContain(
      lost.code,
    );
    expect(p.owner.get(namespace, "issue:work-1")?.value).toMatchObject({
      expectedFiles: wideFiles,
    });
  } finally {
    await p.close();
  }
});
