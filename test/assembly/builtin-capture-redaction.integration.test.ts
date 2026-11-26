import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createNodeFileCapture,
  nodeFileCapture,
} from "../../src/adapters/node-runtime/capture.ts";
import { firstPartyBlocks } from "../../src/assembly/first-party.ts";
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import { exitCode } from "../../src/surface/result.ts";

setDefaultTimeout(30_000);

const example = resolve(import.meta.dirname, "../../examples/hello-block");
const builtinId = "forge/redaction-test";

async function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), "forge-builtin-redact-"));
  const blockDir = join(sandbox, "redacted-block");
  cpSync(example, blockDir, { recursive: true });
  (firstPartyBlocks as Record<string, URL>)[builtinId] =
    pathToFileURL(blockDir);
  const root = join(sandbox, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: { redacted: { source: { builtin: builtinId } } },
    }),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(sandbox, "device"),
    providers: { env: {} },
  });
  const invoke = (op: string) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `redact-${op}`,
      op,
      input: {},
      caller: "human",
      context: localContext(assembly, { kind: "human", id: "test" }),
    });
  return {
    sandbox,
    blockDir,
    assembly,
    invoke,
    async close() {
      await assembly.close();
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

test("builtin capture race keeps INPUT_CONFLICT and exit 4 with no install path", async () => {
  const f = await fixture();
  const racing = createNodeFileCapture(() => {
    appendFileSync(join(f.blockDir, "forge.block.json"), " ");
    appendFileSync(join(f.blockDir, "block.json"), " ");
  });
  const open = spyOn(nodeFileCapture, "open").mockImplementation(
    (rootPath: string) => racing.open(rootPath),
  );
  try {
    const reply = await f.invoke("config.show");
    expect(reply.ok).toBe(false);
    const unavailable = f.assembly.catalog.unavailable();
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.name).toBe("redacted");
    expect(unavailable[0]!.error.code).toBe("INPUT_CONFLICT");
    expect(unavailable[0]!.error.retry).toBe("never");
    expect(unavailable[0]!.reason).toBe("file changed during capture");
    expect(unavailable[0]!.error.message).toBe("file changed during capture");
    expect(unavailable[0]!.reason).not.toContain(f.blockDir);
    expect(unavailable[0]!.reason).not.toContain(
      f.blockDir.replaceAll("\\", "/"),
    );
    expect(
      exitCode({
        ok: false,
        status: "FAIL",
        error: unavailable[0]!.error,
        warnings: [],
      }),
    ).toBe(4);
  } finally {
    open.mockRestore();
    delete (firstPartyBlocks as Record<string, URL>)[builtinId];
    await f.close();
  }
});

test("missing builtin file keeps PROVIDER_MISSING with no install path", async () => {
  const f = await fixture();
  try {
    rmSync(f.blockDir, { recursive: true, force: true });
    const reply = await f.invoke("config.show");
    expect(reply.ok).toBe(false);
    const unavailable = f.assembly.catalog.unavailable();
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.name).toBe("redacted");
    expect(unavailable[0]!.error.code).toBe("PROVIDER_MISSING");
    expect(unavailable[0]!.error.retry).toBe("never");
    expect(unavailable[0]!.reason).not.toContain(f.blockDir);
    expect(unavailable[0]!.reason).not.toContain(
      f.blockDir.replaceAll("\\", "/"),
    );
    expect(unavailable[0]!.reason).toContain("<forge install>");
  } finally {
    delete (firstPartyBlocks as Record<string, URL>)[builtinId];
    await f.close();
  }
});
