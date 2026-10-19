import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly } from "../../../src/assembly/index.ts";

test("assembled block-to-block slots require the process-hook fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-slot-"));
  const json = (folder: string, file: string, value: unknown): void =>
    writeFileSync(join(folder, file), JSON.stringify(value));
  const operation = {
    input: "value.json",
    output: "value.json",
    context: "stateless",
    timeoutMs: 1000,
    effects: [],
    idempotent: true,
    callers: ["human", "agent"],
    stability: "experimental",
  };
  try {
    for (const name of ["consumer", "provider"]) {
      const path = join(root, name);
      mkdirSync(path);
      json(path, "forge.block.json", {
        schemaVersion: "forge.block/1",
        id: `example.org/${name}`,
        version: "1.0.0",
        authorAbi: "forge.author/v1",
        profile: "trusted-action-sync/v1",
        entry: "entry.cjs",
        docs: "docs.json",
        ...(name === "consumer"
          ? { requires: [{ slot: "host", interface: "example.host@1" }] }
          : {
              provides: [{ interface: "example.host@1.0.0", noun: "provider" }],
            }),
        operations: { [`${name}.read`]: operation },
      });
      writeFileSync(join(path, "value.json"), '{"type":"string"}');
      json(path, "docs.json", {
        operations: {
          [`${name}.read`]: { title: "Read", summary: "Read a value." },
        },
      });
      writeFileSync(
        join(path, "entry.cjs"),
        name === "consumer"
          ? "module.exports={'consumer.read':({input,services})=>services.host.read(input)}"
          : "module.exports={'provider.read':({input})=>input}",
      );
    }
    mkdirSync(join(root, ".forge"));
    json(root, ".forge/config.yaml", {
      schemaVersion: "forge.config/1",
      blocks: {
        provider: { source: { path: "./provider" } },
        consumer: {
          source: { path: "./consumer" },
          bind: { host: "provider" },
        },
      },
    });
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    try {
      const unavailable = assembly.catalog.unavailable();
      expect(
        unavailable.find((item) => item.name === "provider"),
      ).toBeUndefined();
      expect(
        unavailable.find((item) => item.name === "consumer")?.error.code,
      ).toBe("PROVIDER_MISSING");
      expect(
        await assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: "slot-probe",
          op: "consumer.read",
          input: "hello",
          caller: "human",
          context: {},
        }),
      ).toMatchObject({ ok: false });
    } finally {
      await assembly.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);
