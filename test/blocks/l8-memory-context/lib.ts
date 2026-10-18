import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { join, resolve } from "node:path";
import { createAssembly, type Assembly } from "../../../src/assembly/index.ts";
import { ForgeFailure } from "../../../src/contract/author.ts";
import type { PutOptions, StateClient } from "../../../src/ports/state.ts";
import type {
  Actor,
  AmbientContext,
  ResultEnvelope,
  StateRecord,
} from "../../../src/generated/types.ts";

const repo = resolve(import.meta.dirname, "../../..");
const transpiler = new Bun.Transpiler({ loader: "ts" });

export type BlockName = "memory" | "context";

/** Copy a block and emit its entry the way the build does, so the block runs as captured bytes. */
export function stageBlock(name: BlockName, into: string): string {
  const target = join(into, name);
  cpSync(join(repo, "src/blocks", name), target, {
    recursive: true,
    filter: (path) => !path.endsWith(".cts"),
  });
  const source = readFileSync(
    join(repo, "src/blocks", name, "index.cts"),
    "utf8",
  );
  writeFileSync(join(target, "index.cjs"), transpiler.transformSync(source));
  return target;
}

type Handler = (args: {
  input: unknown;
  config?: unknown;
  services: unknown;
}) => unknown;

/** The block's handlers, loaded the way the runtime evaluates the entry, for fault-injection tests. */
export function loadEntry(
  name: BlockName,
  without?: { readonly from: string; readonly to: string },
): Record<string, Handler> {
  let source = readFileSync(
    join(repo, "src/blocks", name, "index.cts"),
    "utf8",
  );
  if (without !== undefined) {
    if (!source.includes(without.from))
      throw new Error("fix to remove not found");
    source = source.replace(without.from, without.to);
  }
  const module = { exports: {} as Record<string, Handler> };
  const wrapped = runInNewContext(
    `(function (module, exports) {${transpiler.transformSync(source)}
})`,
  ) as (module: unknown, exports: unknown) => void;
  wrapped(module, module.exports);
  return module.exports;
}

export interface CallOptions {
  readonly caller?: "agent" | "human";
  readonly context?: AmbientContext;
}
export interface Harness {
  readonly assembly: Assembly;
  readonly root: string;
  readonly deviceRoot: string;
  readonly work: string;
  /** Call with the full local context (project and device). */
  call(
    op: string,
    input: unknown,
    options?: CallOptions,
  ): Promise<ResultEnvelope>;
  /** Only an actor and the device: what a host with no project supplies. */
  deviceOnly(): AmbientContext;
  close(): Promise<void>;
}

const human: Actor = { kind: "human", id: "tester" };
const agent: Actor = { kind: "agent", id: "agent-one" };

export function done(result: ResultEnvelope): unknown {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.result;
}

const effects: Record<BlockName, string[]> = {
  memory: ["memory:write", "decision:write"],
  context: ["context:write"],
};

/** Build an assembly in temp folders, add the blocks by path, and admit and grant them as a human. */
export async function openHarness(
  blocks: readonly BlockName[],
  settings: Readonly<Record<string, unknown>> = {},
): Promise<Harness> {
  const work = mkdtempSync(join(tmpdir(), "forge-l8-"));
  const root = join(work, "project");
  const deviceRoot = join(work, "device");
  mkdirSync(root);
  const assembly = await createAssembly({ root, deviceRoot });
  let counter = 0;
  const ambient = (actor: Actor): AmbientContext => ({
    actor,
    project: { id: assembly.root, root: assembly.root },
    device: { id: assembly.deviceRoot },
  });
  async function call(
    op: string,
    input: unknown,
    options: CallOptions = {},
  ): Promise<ResultEnvelope> {
    counter += 1;
    const caller = options.caller ?? "human";
    return assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `l8-${counter}`,
      op,
      input,
      caller,
      context: options.context ?? ambient(caller === "human" ? human : agent),
    });
  }
  const stage = join(root, "blocks");
  mkdirSync(stage);
  for (const name of blocks) {
    stageBlock(name, stage);
    const added = await call("block.add", { path: `./blocks/${name}` });
    const digest = /sha256:[a-f0-9]{64}/.exec(
      added.ok ? "" : (added.error?.repair ?? ""),
    )?.[0];
    if (!digest) throw new Error(`block.add ${name}: ${JSON.stringify(added)}`);
    done(await call("block.admit", { digest }));
    done(await call("config.grant", { digest, effects: effects[name] }));
  }
  for (const [path, value] of Object.entries(settings)) {
    const shown = done(await call("config.show", {})) as { revision: string };
    done(
      await call("config.set", {
        path,
        value,
        expectRevision: shown.revision,
      }),
    );
  }
  return {
    assembly,
    root,
    deviceRoot,
    work,
    call,
    deviceOnly: () => ({ actor: agent, device: { id: assembly.deviceRoot } }),
    async close() {
      await assembly.close();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/** A state client whose next write loses a race: another writer lands first. */
export function racing(
  onFirstPut: (state: Map<string, StateRecord>) => void,
): StateClient {
  const records = new Map<string, StateRecord>();
  let raced = false;
  return {
    get: (key) => records.get(key),
    list: (prefix = "") =>
      [...records.values()].filter((r) => r.key.startsWith(prefix)),
    events: () => [],
    put(key, value, options: PutOptions) {
      if (!raced) {
        raced = true;
        onFirstPut(records);
      }
      const current = records.get(key);
      if ((current?.revision ?? 0) !== options.expectRevision)
        throw new ForgeFailure({
          code: "REVISION_CONFLICT",
          message: "stale",
          retry: "reconcile_first",
        });
      const record = {
        namespace: "forge/context",
        key,
        revision: (current?.revision ?? 0) + 1,
        value,
        updatedAt: "2026-10-18T00:00:00Z",
        updatedBy: { kind: "agent", id: "a" },
      } as StateRecord;
      records.set(key, record);
      return record;
    },
  };
}
