import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localContext } from "../../../src/assembly/index.ts";
import * as providerModule from "../../../src/assembly/providers.ts";
import { createAssemblyProviders } from "../../../src/assembly/providers.ts";
import type { ProcessPort } from "../../../src/ports/process.ts";

test("assembled pure crypto never opens the block's unused file service", async () => {
  const root = mkdtempSync(join(tmpdir(), "pure-provider-"));
  const providers = createAssemblyProviders(root, { env: {} });
  const openFiles = spyOn(providers, "openFiles");
  const factory = spyOn(
    providerModule,
    "createAssemblyProviders",
  ).mockReturnValue(providers);
  const stateRoot = spyOn(providerModule, "projectStateRoot").mockResolvedValue(
    root,
  );
  const prefix = spyOn(providerModule, "idPrefixObservation").mockResolvedValue(
    [],
  );
  const block = join(root, "fixture");
  mkdirSync(block);
  const operations = Object.fromEntries(
    ["crypto", "denied"].map((verb) => [
      `probe.${verb}`,
      {
        input: "value.json",
        output: "value.json",
        context: "project",
        effects: [],
        idempotent: true,
        callers: ["human", "agent"],
        stability: "experimental",
        timeoutMs: 10000,
      },
    ]),
  );
  writeFileSync(
    join(block, "forge.block.json"),
    JSON.stringify({
      schemaVersion: "forge.block/1",
      id: "example.org/pure",
      version: "1.0.0",
      authorAbi: "forge.author/v2",
      profile: "trusted-action/v2",
      entry: "entry.cjs",
      docs: "docs.json",
      requires: [
        { slot: "crypto", interface: "forge.crypto@1" },
        { slot: "files", interface: "forge.files@1" },
      ],
      operations,
    }),
  );
  writeFileSync(
    join(block, "docs.json"),
    JSON.stringify({
      operations: Object.fromEntries(
        Object.keys(operations).map((op) => [
          op,
          { title: op, summary: "Probe services." },
        ]),
      ),
    }),
  );
  writeFileSync(join(block, "value.json"), '{"type":"string"}');
  writeFileSync(
    join(block, "entry.cjs"),
    "module.exports={'probe.crypto':({input,services})=>services.crypto.sha256(input),'probe.denied':({services})=>services.files.roots.project}",
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  let sequence = 0;
  const invoke = (op: string, input: unknown) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `pure-${++sequence}`,
      op,
      input,
      caller: "human",
      context: localContext(
        assembly,
        { kind: "human", id: "fixture" },
        "fixture",
      ),
    });
  try {
    expect(await invoke("block.add", { path: "./fixture" })).toMatchObject({
      ok: true,
    });
    const checked = await invoke("block.check", { path: "./fixture" });
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw Error(JSON.stringify(checked));
    const digest = (checked.result as { digest: string }).digest;
    expect(await invoke("block.admit", { digest })).toMatchObject({ ok: true });
    expect(await invoke("probe.crypto", "fixture")).toMatchObject({
      ok: true,
      result: providers
        .crypto({
          op: "probe.crypto",
          effects: [],
          signal: new AbortController().signal,
          deadline: Date.now() + 10000,
          processContainment: "supervised",
        })
        .sha256("fixture"),
    });
    expect(openFiles).not.toHaveBeenCalled();
    expect(await invoke("probe.denied", "")).toMatchObject({
      ok: false,
      error: {
        code: "EFFECT_UNDECLARED",
        message: "Clone file access requires files:read or files:write",
      },
    });
    expect(openFiles).not.toHaveBeenCalled();
  } finally {
    await assembly.close();
    factory.mockRestore();
    stateRoot.mockRestore();
    prefix.mockRestore();
    openFiles.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("an operation without file effects starts no Git discovery and cannot use the slot", async () => {
  let starts = 0;
  const process: ProcessPort = {
    capability: "forge.process/v1",
    resolve: () => ({ kind: "resolved", path: "git" }),
    run: () => {
      starts++;
      throw new Error("Unexpected Git discovery");
    },
  };
  const lease = await createAssemblyProviders(
    "/project",
    { env: {} },
    process,
  ).openFiles({
    op: "sample.list",
    effects: [],
    signal: new AbortController().signal,
    deadline: Date.now() + 30000,
    processContainment: "supervised",
  });
  expect(starts).toBe(0);
  expect(() => lease.value.read("file", 100)).toThrow(
    "files:read or files:write",
  );
  expect(() => lease.value.roots).toThrow("files:read or files:write");
  await lease.close();
}, 5000);
