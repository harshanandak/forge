import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";
import { dispatch, record } from "../../src/surface/dispatch.ts";
import { failure } from "../../src/surface/result.ts";
import { validateResultEnvelope } from "../../src/generated/validators.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

test("inactive bundled operations and nouns name the import that enables them", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-inactive-"));
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  try {
    const options = localCall(assembly);
    for (const op of ["issue.list", "issue.show"]) {
      const result = await dispatch(assembly.catalog, op, {}, options);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "UNKNOWN_COMMAND",
          retry: "reconcile_first",
          hint: {
            template: "delivery",
            command: "forge template import delivery",
          },
        },
      });
      if (result.ok) throw new Error("Expected inactive operation refusal");
      expect(result.error.message).toContain("delivery");
      expect(validateResultEnvelope(result).ok).toBe(true);
    }
    const bare = await runCli(assembly.catalog, ["issue", "--json"], options);
    expect(bare.envelope).toMatchObject({
      ok: false,
      error: {
        code: "UNKNOWN_COMMAND",
        retry: "reconcile_first",
        hint: {
          template: "delivery",
          command: "forge template import delivery",
        },
      },
    });
    expect(await dispatch(assembly.catalog, "issue.lsit", {}, options)).toEqual(
      failure("UNKNOWN_COMMAND", "Unknown operation: issue.lsit"),
    );
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a bare noun lists each visible verb and summary without invoking it", async () => {
  const entries = [candidate("sample.echo"), candidate("sample.show")];
  const catalog = fakeCatalog([
    ...entries,
    candidate("sample.secret", { callers: ["human"] }),
    candidate("sample.write", { effects: ["sample:write"] }),
  ]);
  const options = { caller: "agent", readOnly: true } as const;
  const response = await runCli(catalog, ["sample", "--json"], options);
  expect(response.exitCode).toBe(0);
  expect(JSON.parse(response.stdout)).toMatchObject({ ok: true });
  const operations = record(
    response.envelope.ok ? response.envelope.result : undefined,
  )?.operations;
  expect(operations).toEqual(entries);
  const text = await runCli(catalog, ["sample", "--text"], options);
  for (const entry of entries) {
    expect(text.stdout).toContain(entry.op);
    expect(text.stdout).toContain(entry.docs.summary);
  }
  expect(text.stdout).not.toContain("sample.secret");
  expect(text.stdout).not.toContain("sample.write");
  expect(catalog.calls).toHaveLength(0);
}, 30_000);

test("hidden operations stay unknown and typos retain their exact suggestions", async () => {
  const catalog = fakeCatalog([
    candidate("sample.echo", { callers: ["human"] }),
    candidate("sample.write", { effects: ["sample:write"] }),
    candidate("issue.list"),
  ]);
  for (const op of ["sample.echo", "sample.write"]) {
    const result = await dispatch(
      catalog,
      op,
      {},
      { caller: "agent", readOnly: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_COMMAND");
      expect(result.error.hint).toBeUndefined();
      expect(result.error.retry).toBe("never");
    }
  }
  expect(
    await dispatch(catalog, "issue.lsit", {}, { caller: "agent" }),
  ).toEqual(
    failure("UNKNOWN_COMMAND", "Unknown operation: issue.lsit", ["issue.list"]),
  );
  expect(catalog.calls).toHaveLength(0);
}, 30_000);
