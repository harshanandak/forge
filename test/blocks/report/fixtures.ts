import { createHash } from "node:crypto";
import { spyOn } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import { captureBlock, Catalog } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import type { StateRecord } from "../../../src/generated/types.ts";

export async function withReportAssembly(
  run: (
    assembly: Awaited<ReturnType<typeof createAssembly>>,
    options: ReturnType<typeof localCall>,
  ) => Promise<void>,
  config: object | string | false = {
    schemaVersion: "forge.config/1",
    blocks: { report: { source: { builtin: "forge/report" } } },
  },
) {
  const root = mkdtempSync(join(tmpdir(), "forge-report-"));
  const deviceRoot = join(root, "device");
  const source = firstPartyBlocks["forge/report"];
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open");
  try {
    if (source !== undefined) {
      const path = fileURLToPath(source);
      const staged = join(root, "staged");
      await stageReport(path, staged);
      capture.mockImplementation((file) => open(file === path ? staged : file));
    }
    if (config !== false) {
      mkdirSync(join(root, ".forge"));
      writeFileSync(
        join(root, ".forge/config.yaml"),
        typeof config === "string" ? config : JSON.stringify(config),
      );
    }
    const assembly = await createAssembly({
      root,
      deviceRoot,
      providers: { env: {} },
    });
    try {
      await run(assembly, localCall(assembly));
    } finally {
      await assembly.close();
    }
  } finally {
    capture.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}

async function stageReport(path: string, staged: string) {
  cpSync(path, staged, {
    recursive: true,
    filter: (file) => !/\.[cm]?ts$/.test(file),
  });
  const bundle = await Bun.build({
    entrypoints: [join(path, "entry.cts")],
    format: "cjs",
  });
  writeFileSync(join(staged, "entry.cjs"), await bundle.outputs[0]!.text());
}

const reportSource = { builtin: "forge/report" };
const actor = { kind: "agent", id: "fixture" } as const;

export function hashReport(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function withReportRuntime(
  run: (fixture: ReturnType<typeof reportRuntime>) => Promise<void>,
  context: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "forge-report-runtime-"));
  try {
    await stageReport(fileURLToPath(firstPartyBlocks["forge/report"]!), root);
    await run(reportRuntime(root, context));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function reportRuntime(root: string, context: Record<string, string>) {
  const block = captureBlock(root, blockCapture, undefined, true);
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: { report: { source: reportSource } },
    },
    new Map([["report", block]]),
    undefined,
    ["forge.state@1.0.0", "forge.crypto@1.0.0"],
  );
  const records = new Map<string, StateRecord>();
  const history: StateRecord[] = [];
  const state = {
    host: {
      labels: ["SecretProject", "Secret Repository"],
      context,
      now: () => 1_800_000_000_000,
    },
    get: (key: string) => records.get(key),
    put(
      key: string,
      value: unknown,
      { expectRevision }: { expectRevision: number },
    ) {
      const record: StateRecord = {
        namespace: "forge/report",
        key,
        value,
        revision: expectRevision + 1,
        updatedBy: actor,
        updatedAt: "2027-01-15T08:00:00.000Z",
      };
      records.set(key, record);
      history.push(record);
      return record;
    },
  };
  const runtime = new Runtime(catalog, new TrustStore(), {
    isolation: nodeRunIsolation,
    services: () =>
      Promise.resolve({
        ownership: "borrowed",
        value: { state, crypto: { sha256: hashReport } },
      }),
  });
  return {
    records,
    history,
    file: (input: unknown, caller: "agent" | "human" = "agent") =>
      runtime.invoke({
        schemaVersion: "forge.invocation/1",
        requestId: "fixture",
        op: "report.create",
        caller,
        input,
        context: { actor, device: { id: "device" } },
      }),
  };
}
