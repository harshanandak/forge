import { expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Catalog, captureBlock } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import { ASSEMBLY_PROVIDES } from "../../../src/assembly/providers.ts";
import { createAssembly } from "../../../src/assembly/index.ts";

setDefaultTimeout(1000);

function fixture() {
  const root = resolve(
    import.meta.dirname,
    "../../../src/blocks/github-accounts",
  );
  const block = captureBlock(root, {
    open: () => ({
      ownership: "borrowed",
      value: {
        read(name) {
          if (name === "entry.cjs")
            return Buffer.from(
              new Bun.Transpiler({ loader: "ts" }).transformSync(
                readFileSync(join(root, "entry.cts"), "utf8"),
              ),
            );
          return readFileSync(
            join(root, name === "block.json" ? "forge.block.json" : name),
          );
        },
      },
    }),
  });
  const config = {
    environmentNames: [],
    gitProgram: "git",
    ghProgram: "gh",
    ghArgs: [],
    commandTimeoutMs: 1000,
    maxOutputBytes: 10000,
    maxFileBytes: 10000,
    maxCommits: 10,
    coauthorPolicy: "strip",
    aiCoauthorPatterns: ["codex"],
    forgeCommand: ["forge"],
    shellProgram: "sh",
    envProgram: "env",
    allowedGhCommands: [],
    identityName: "profile",
    identityEmail: "noreply",
  };
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: {
        "github-accounts": { source: { path: "./github-accounts" }, config },
      },
    },
    new Map([["github-accounts", block]]),
    undefined,
    ASSEMBLY_PROVIDES,
  );
  const trust = new TrustStore();
  trust.admit("human", block.digest);
  const accessed: string[] = [];
  const runtime = new Runtime(catalog, trust, {
    isolation: nodeRunIsolation,
    services: () =>
      Promise.resolve({
        ownership: "borrowed",
        value: {
          get files() {
            accessed.push("files");
            throw new Error("Pure policy accessed files");
          },
          get environment() {
            accessed.push("environment");
            throw new Error("Pure policy accessed environment");
          },
          get process() {
            accessed.push("process");
            throw new Error("Pure policy accessed process");
          },
          get repository() {
            accessed.push("repository");
            throw new Error("Pure policy accessed repository");
          },
          get account() {
            accessed.push("account");
            throw new Error("Pure policy accessed account");
          },
          get crypto() {
            accessed.push("crypto");
            throw new Error("Pure policy accessed crypto");
          },
        },
      }),
  });
  return { runtime, accessed, config };
}

test.each([
  {},
  {
    actor: { kind: "agent" as const, id: "tester" },
    project: { id: "/project", root: "/project" },
  },
])(
  "admitted source message runs with zero grants and no service access (%j)",
  async (context) => {
    const f = fixture();
    const text = "Change\n\nCo-authored-by: Codex <bot@example.com>\n";
    const result = await f.runtime.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: "pure-message",
      op: "github-account.message",
      input: { text },
      caller: "agent",
      context,
    });
    expect(result).toMatchObject({
      ok: true,
      result: { text: "Change\n", changed: true },
    });
    expect(f.accessed).toEqual([]);
  },
);

test("stock assembly invokes admitted text policy without grants or project context", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-account-pure-"));
  const block = join(root, "block");
  const source = resolve(
    import.meta.dirname,
    "../../../src/blocks/github-accounts",
  );
  cpSync(source, block, { recursive: true });
  writeFileSync(
    join(block, "entry.cjs"),
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      readFileSync(join(source, "entry.cts"), "utf8"),
    ),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  let sequence = 0;
  const call = (op: string, input: unknown) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `assembly-message-${++sequence}`,
      op,
      input,
      caller: "human",
      context: {
        actor: { kind: "human", id: "tester" },
        device: { id: "test-device" },
        project: { id: root, root },
      },
    });
  try {
    const shown = await call("config.show", {});
    if (!shown.ok) throw new Error(JSON.stringify(shown.error));
    expect(
      await call("config.apply", {
        expectRevision: (shown.result as { revision: string }).revision,
        patch: [
          {
            op: "set",
            path: "/blocks/github-accounts",
            value: { source: { path: "./block" }, config: fixture().config },
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    const checked = await call("block.check", { path: "./block" });
    expect(checked).toMatchObject({ ok: true });
    if (!checked.ok) throw new Error(JSON.stringify(checked.error));
    const digest = (checked.result as { digest: string }).digest;
    expect(await call("block.admit", { digest })).toMatchObject({ ok: true });
    expect(
      await assembly.catalog.invoke({
        schemaVersion: "forge.invocation/1",
        requestId: "stateless-message",
        op: "github-account.message",
        input: { text: "Change\n\nCo-authored-by: Codex <bot@example.com>\n" },
        caller: "agent",
        context: {},
      }),
    ).toMatchObject({ ok: true, result: { text: "Change\n", changed: true } });
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("message-file retains effect admission and the two operations reject mixed inputs", async () => {
  const f = fixture();
  const invoke = (op: string, input: unknown) =>
    f.runtime.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: "message-schema",
      op,
      input,
      caller: "agent",
      context: {
        actor: { kind: "agent", id: "tester" },
        project: { id: "/project", root: "/project" },
      },
    });
  expect(
    await invoke("github-account.message-file", { path: "COMMIT_EDITMSG" }),
  ).toMatchObject({ ok: false, error: { code: "GRANT_REQUIRED" } });
  for (const [op, input] of [
    ["github-account.message", { path: "COMMIT_EDITMSG" }],
    ["github-account.message", { text: "Change", path: "COMMIT_EDITMSG" }],
    ["github-account.message", {}],
    ["github-account.message-file", { text: "Change" }],
    ["github-account.message-file", {}],
  ] as const)
    expect(await invoke(op, input)).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID" },
    });
  expect(f.accessed).toEqual([]);
});
