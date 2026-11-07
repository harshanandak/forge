// `forge laws check` through the real assembly: the report is the result, and the exit code follows
// the other report operations: 0 when every law is enforced, 1 when a law is broken or the laws
// section is malformed, 2 when a law is written down but nothing enforces it.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";

setDefaultTimeout(30_000);

const CODEX = "chatgpt-codex-connector[bot]";
const GATE = "/blocks/check/config/gate";

async function run(laws: unknown) {
  const root = mkdtempSync(join(tmpdir(), "forge-laws-check-"));
  mkdirSync(join(root, ".forge"));
  const text = JSON.stringify({
    schemaVersion: "forge.config/1",
    blocks: {
      check: {
        source: { builtin: "forge/check" },
        config: { commands: {}, gate: { headReviewers: [CODEX] } },
      },
    },
    laws,
  });
  writeFileSync(join(root, ".forge/config.yaml"), text);
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
  });
  try {
    return await runCli(
      assembly.catalog,
      ["laws", "check"],
      localCall(assembly),
    );
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const merge = (requires: Record<string, unknown>) => ({
  says: "a merge law",
  at: "merge",
  requires,
});

test("laws check exits 0 when every law is enforced", async () => {
  const { envelope, exitCode } = await run({
    "codex-reviews": merge({ [`${GATE}/headReviewers`]: { contains: CODEX } }),
  });
  expect(envelope, JSON.stringify(envelope)).toMatchObject({
    ok: true,
    result: { verdict: "PASS", summary: { enforced: 1 } },
  });
  expect(exitCode).toBe(0);
});

test("laws check exits 1 and keeps the report when a law is broken", async () => {
  const { envelope, exitCode } = await run({
    "needs-receipt": merge({ [`${GATE}/receiptChecks`]: { nonEmpty: true } }),
  });
  expect(envelope, JSON.stringify(envelope)).toMatchObject({
    ok: false,
    status: "FAIL",
    error: { code: "LAWS_BROKEN" },
    result: { verdict: "FAIL", summary: { broken: 1 } },
  });
  expect(exitCode).toBe(1);
});

test("laws check exits 2 and keeps the report when a law has no enforcer", async () => {
  const { envelope, exitCode } = await run({
    "tests-first": {
      says: "tests pass before every push",
      at: "push",
      requires: { "/values/tests": { equals: true } },
    },
  });
  expect(envelope, JSON.stringify(envelope)).toMatchObject({
    ok: false,
    status: "INCOMPLETE",
    error: { code: "LAWS_UNENFORCED" },
    result: { verdict: "INCOMPLETE", summary: { unenforced: 1 } },
  });
  expect(exitCode).toBe(2);
});
