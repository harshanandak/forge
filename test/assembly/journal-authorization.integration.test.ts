import { expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import { createAssemblyProviders } from "../../src/assembly/providers.ts";
import type { ServiceScope } from "../../src/core/runtime/index.ts";
import { relay } from "../fixtures/owner-approval.ts";

setDefaultTimeout(30_000);

interface JournalService {
  append(
    this: void,
    line: string,
    policy: { readonly maxBytes: number; readonly maxFiles: number },
  ): void;
  read(this: void): {
    readonly lines: readonly string[];
    readonly incomplete: boolean;
  };
}

type JournalProvider = (
  instance: string,
  scope: ServiceScope,
) => JournalService;

function operation(effects: readonly string[]) {
  return {
    input: "value.json",
    output: "value.json",
    context: "device",
    effects,
    idempotent: false,
    callers: ["human", "agent"],
    stability: "experimental",
    timeoutMs: 5000,
  };
}

function scope(
  effects: readonly string[],
  signal = new AbortController().signal,
): ServiceScope {
  return {
    op: "probe.journal",
    effects,
    signal,
    deadline: Date.now() + 5000,
    processContainment: "supervised",
  };
}

test("receipt effects are authorized without note write authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-journal-assembly-"));
  const deviceRoot = join(root, "device");
  const block = join(root, "probe");
  mkdirSync(block);
  const operations = {
    "probe.journal": operation(["files:read", "files:write"]),
    "probe.denied": operation([]),
  };
  writeFileSync(
    join(block, "forge.block.json"),
    JSON.stringify({
      schemaVersion: "forge.block/1",
      id: "example.org/probe",
      version: "1.0.0",
      authorAbi: "forge.author/v2",
      profile: "trusted-action/v2",
      entry: "entry.cjs",
      docs: "docs.json",
      requires: [{ slot: "journal", interface: "forge.journal@1" }],
      operations,
    }),
  );
  writeFileSync(
    join(block, "docs.json"),
    JSON.stringify({
      operations: Object.fromEntries(
        Object.keys(operations).map((op) => [
          op,
          { title: op, summary: "Probe the journal service." },
        ]),
      ),
    }),
  );
  writeFileSync(join(block, "value.json"), '{"type":"string"}');
  writeFileSync(
    join(block, "entry.cjs"),
    `module.exports={
      "probe.journal":({services})=>{
        const journal=services.journal;
        const append=journal.append;
        const read=journal.read;
        const line=JSON.stringify({receipt:"served"});
        append(line,{maxBytes:131072,maxFiles:1});
        const result=read();
        return JSON.stringify({
          serviceKeys:Object.keys(services).sort(),
          journalKeys:Object.keys(journal).sort(),
          lines:result.lines,
          incomplete:result.incomplete,
          noteWrite:["put","write","remove","delete","set"].some((key)=>key in journal)
        });
      },
      "probe.denied":({services})=>{
        const append=services.journal.append;
        append(JSON.stringify({receipt:"denied"}),{maxBytes:131072,maxFiles:1});
        return "unexpected";
      }
    };`,
  );
  const assembly = await createAssembly({ root, deviceRoot });
  let sequence = 0;
  const invoke = (op: string, input: unknown) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `journal-${++sequence}`,
      op,
      input,
      caller: "human",
      context: localContext(
        assembly,
        { kind: "human", id: "journal-fixture" },
        "journal-fixture",
      ),
    });
  try {
    const added = await invoke("block.add", { path: "./probe" });
    expect(added.ok).toBe(true);
    if (!added.ok) throw Error(JSON.stringify(added));
    const { digest } = added.result as { digest: string };
    expect((await relay(invoke, "block.admit", { digest })).ok).toBe(true);
    expect(
      (
        await relay(invoke, "config.grant", {
          digest,
          effects: ["files:read", "files:write"],
        })
      ).ok,
    ).toBe(true);
    const ran = await invoke("probe.journal", "write");
    expect(ran).toMatchObject({ ok: true, status: "OK" });
    if (!ran.ok) throw Error(JSON.stringify(ran));
    const report = JSON.parse(String(ran.result)) as {
      serviceKeys: string[];
      journalKeys: string[];
      lines: string[];
      incomplete: boolean;
      noteWrite: boolean;
    };
    expect(report.serviceKeys).toEqual(["journal"]);
    expect(report.journalKeys).toEqual(["append", "read"]);
    expect(report.lines).toEqual([JSON.stringify({ receipt: "served" })]);
    expect(report.incomplete).toBe(false);
    expect(report.noteWrite).toBe(false);
    expect(existsSync(join(deviceRoot, "logs", "probe", "journal.jsonl"))).toBe(
      true,
    );
    const denied = await invoke("probe.denied", "denied");
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "EFFECT_UNDECLARED" },
    });
    expect(
      existsSync(join(deviceRoot, "logs", "probe", "journal.jsonl.1")),
    ).toBe(false);

    const providers = createAssemblyProviders(root, { deviceRoot, env: {} });
    const journalProvider = (
      providers as unknown as { journal?: JournalProvider }
    ).journal;
    expect(journalProvider).toBeFunction();
    if (journalProvider === undefined)
      throw new Error("journal provider is not composed");
    const active = journalProvider(
      "probe",
      scope(["files:read", "files:write"]),
    );
    const cachedAppend = active.append;
    const cachedRead = active.read;
    const directLine = JSON.stringify({ receipt: "direct" });
    cachedAppend(directLine, { maxBytes: 131072, maxFiles: 1 });
    expect(cachedRead().lines).toContain(directLine);
    const readOnly = journalProvider("probe", scope(["files:read"]));
    expect(() =>
      readOnly.append(directLine, { maxBytes: 131072, maxFiles: 1 }),
    ).toThrow(/EFFECT_UNDECLARED/);
    const writeOnly = journalProvider("probe", scope(["files:write"]));
    expect(() => writeOnly.read()).toThrow(/EFFECT_UNDECLARED/);
    const controller = new AbortController();
    controller.abort();
    const expired = journalProvider(
      "probe",
      scope(["files:read", "files:write"], controller.signal),
    );
    const expiredAppend = expired.append;
    const expiredRead = expired.read;
    expect(() =>
      expiredAppend(directLine, { maxBytes: 131072, maxFiles: 1 }),
    ).toThrow(/SERVICE_EXPIRED/);
    expect(() => expiredRead()).toThrow(/SERVICE_EXPIRED/);
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
