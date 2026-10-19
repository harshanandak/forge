import { expect, test, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly } from "../../../src/assembly/index.ts";
import * as providerModule from "../../../src/assembly/providers.ts";
import { fakeProcess } from "../../adapters/process/fake-process.ts";
import type { AmbientContext } from "../../../src/generated/types.ts";

async function fixture(
  leases = false,
  strict?: { slot: "repository" | "account" | "process"; files: boolean },
) {
  const root = mkdtempSync(join(tmpdir(), "forge-stateless-files-"));
  const block = join(root, "block");
  mkdirSync(block);
  const effects = {
    pure: strict ? ["external:process"] : [],
    dishonest: strict ? ["external:process"] : [],
    read: ["files:read"],
  };
  const operations = Object.fromEntries(
    Object.entries(effects).map(([name, declared]) => [
      `sample.${name}`,
      {
        input: "input.json",
        output: "output.json",
        context: "stateless",
        ...(strict && name !== "read" ? { processContainment: "strict" } : {}),
        effects: declared,
        idempotent: true,
        callers: ["agent", "human"],
        stability: "experimental",
        timeoutMs: 5000,
      },
    ]),
  );
  for (const [name, content] of Object.entries({
    "forge.block.json": JSON.stringify({
      schemaVersion: "forge.block/1",
      id: "example.org/sample",
      version: "1.0.0",
      authorAbi: "forge.author/v2",
      profile: "trusted-action/v2",
      entry: "entry.cjs",
      docs: "docs.json",
      requires: strict
        ? [
            {
              slot: strict.slot,
              interface:
                strict.slot === "process"
                  ? "forge.process@1"
                  : `forge.${strict.slot === "repository" ? "vcs" : "github"}-command@1`,
            },
            ...(strict.files
              ? [{ slot: "files", interface: "forge.files@1" }]
              : []),
          ]
        : leases
          ? ["one", "two", "three"].map((slot) => ({
              slot,
              interface: "forge.vcs-command@1",
            }))
          : [{ slot: "files", interface: "forge.files@1" }],
      operations,
    }),
    "docs.json": JSON.stringify({
      operations: Object.fromEntries(
        Object.keys(operations).map((op) => [
          op,
          { title: op, summary: "Exercise per-operation file authority." },
        ]),
      ),
    }),
    "input.json": '{"type":"object","additionalProperties":false}',
    "output.json": "{}",
    "entry.cjs": `module.exports = {
      "sample.pure": async ({services}) => ${strict ? `services.${strict.slot}.run(${strict.slot === "process" ? '{kind:"resolved",path:"/fake/bin/git"}' : '"git"'}, ["--version"], {cwd:"/project",env:{},timeoutMs:1000,maxOutputBytes:1024})` : '"pure"'},
      "sample.dishonest": async ({ services }) => services.files.read("input", 10),
      "sample.read": async ({ services }) => services.files.read("input", 10)
    };`,
  }))
    writeFileSync(join(block, name), content);
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: { sample: { source: { path: "./block" } } },
    }),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
  });
  let sequence = 0;
  const call = (
    op: string,
    input: unknown = {},
    context: AmbientContext = {},
  ) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `stateless-files-${++sequence}`,
      op,
      input,
      caller: "human",
      context,
    });
  const configurationContext: AmbientContext = {
    actor: { kind: "human", id: "fixture" },
    project: { id: root, root },
    device: { id: join(root, "device") },
  };
  const checked = await call(
    "block.check",
    { path: "./block" },
    configurationContext,
  );
  expect(checked).toMatchObject({ ok: true });
  if (!checked.ok) throw new Error(checked.error.message);
  const digest = (checked.result as { digest: string }).digest;
  expect(
    await call("block.admit", { digest }, configurationContext),
  ).toMatchObject({ ok: true });
  return { call, root, assembly, configurationContext, digest };
}

test("stateless file consumers acquire clone services only for declared file effects", async () => {
  const { call, root, assembly, configurationContext, digest } =
    await fixture();
  try {
    expect(await call("sample.pure")).toMatchObject({
      ok: true,
      result: "pure",
    });
    expect(await call("sample.dishonest")).toMatchObject({
      ok: false,
      error: { code: "EFFECT_UNDECLARED" },
    });
    expect(
      await call(
        "config.grant",
        { digest, effects: ["files:read"] },
        configurationContext,
      ),
    ).toMatchObject({ ok: true });
    expect(await call("sample.read")).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_MISSING" },
    });
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

for (const mode of [
  "success",
  "refusal",
  "partial",
  "abort",
  "cleanup",
] as const)
  test(`three acquired leases close on ${mode}`, async () => {
    const original = providerModule.createAssemblyProviders;
    let acquired = 0;
    let closed = 0;
    const cleanup = new Error("cleanup fixture");
    const primary = new Error("acquisition fixture");
    const mock = spyOn(
      providerModule,
      "createAssemblyProviders",
    ).mockImplementation((...args) => ({
      ...original(...args),
      repository(_scope) {
        const number = ++acquired;
        return Promise.resolve({
          ownership: "owned" as const,
          get value() {
            if (mode === "partial" && number === 3) throw primary;
            if (mode === "abort" && number === 3)
              throw new DOMException("aborted", "AbortError");
            return {} as import("../../../src/ports/tool-command.ts").ToolCommandPort;
          },
          close() {
            closed++;
            if (mode === "cleanup" && number === 1) throw cleanup;
            return Promise.resolve();
          },
        });
      },
    }));
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      h = await fixture(true);
      const result = await h.call(
        mode === "refusal" ? "sample.dishonest" : "sample.pure",
      );
      expect(acquired).toBe(3);
      expect(closed).toBe(3);
      expect(result.ok).toBe(mode === "success");
    } finally {
      mock.mockRestore();
      if (h) {
        await h.assembly.close();
        rmSync(h.root, { recursive: true, force: true });
      }
    }
  }, 30000);

for (const spec of [
  { slot: "repository", files: false },
  { slot: "account", files: false },
  { slot: "process", files: true },
  { slot: "repository", files: true },
  { slot: "account", files: true },
] as const)
  test(`strict ${spec.slot} preflight with files slot ${spec.files} runs only declared capabilities`, async () => {
    const process = {
      ...fakeProcess(["git"], () => ({ stdout: "version fixture" })),
      containment: () =>
        Promise.resolve({
          available: true as const,
          backend: "windows-job" as const,
        }),
    };
    const original = providerModule.createAssemblyProviders;
    const mock = spyOn(
      providerModule,
      "createAssemblyProviders",
    ).mockImplementation((root, options) => original(root, options, process));
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      h = await fixture(false, spec);
      expect(
        await h.call(
          "config.grant",
          { digest: h.digest, effects: ["external:process"] },
          h.configurationContext,
        ),
      ).toMatchObject({ ok: true });
      expect(await h.call("sample.pure")).toMatchObject({
        ok: true,
        result: { exitCode: 0, stdout: "version fixture" },
      });
      expect(process.runs).toHaveLength(1);
      expect(process.runs[0]?.options.containment).toBe("strict");
      if (spec.files)
        expect(await h.call("sample.dishonest")).toMatchObject({
          ok: false,
          error: { code: "EFFECT_UNDECLARED" },
        });
    } finally {
      mock.mockRestore();
      if (h) {
        await h.assembly.close();
        rmSync(h.root, { recursive: true, force: true });
      }
    }
  }, 30000);
