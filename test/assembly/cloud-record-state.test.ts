import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssembly } from "../../src/assembly/index.ts";
import { LocalState } from "../../src/assembly/state.ts";
import {
  credentialStore,
  openCloudFiles,
} from "../../src/assembly/cloud-profile.ts";
import type {
  StateCommitRequest,
  StateReadRequest,
} from "../../src/ports/state-protocol.ts";
import type { StateRecord, ResultEnvelope } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import { relay } from "../fixtures/owner-approval.ts";
import * as fx from "./cloud-fixture.ts";

setDefaultTimeout(30_000);
const NOW = Date.UTC(2026, 10, 11);
const namespace = "test/remote";
const actor = { kind: "human" as const, id: "tester" };
const prefix = fx.PROJECT_ID.replaceAll("-", "").slice(0, 16);
const body = `module.exports={"probe.run":async({services:{records,levels},input})=>{
 const s=input.device?records:(await levels.project()).state;
 if(input.mode==="identity")return (await levels.project()).identity;
 if(input.mode==="peer")return {status:(await levels.peer(input.ref)).status};
 if(input.mode==="read")return {record:await s.get("missing")};
 if(input.mode==="history")return {events:await s.history({key:"note/1",limit:2,before:3})};
 if(input.mode==="plan"){
  await s.get("missing");await s.range({from:"note/",limit:1});await s.count("note/");await s.max("note/");
  await s.put("note/1","one",{expectRevision:0});
  await s.put("note/2","two",{expectRevision:0});return {ok:true};
 }
 if(input.mode==="conflict"){
  await s.get("missing");try{await s.put("note/1","one",{expectRevision:0});}catch(e){}
  await s.get("missing");await s.put("note/1","one",{expectRevision:0});return {ok:true};
 }
 if(input.mode==="replay"){
  await s.put("note/1","one",{expectRevision:0});
  const value={text:"two"};try{await s.put("note/2",value,{expectRevision:0});}catch(e){}
  value.text="mutated";
  let refused=false;try{await s.get("missing");}catch(e){refused=true;}
  if(!refused)throw Error("pending commit allowed a new read plan");
  try{await s.put("note/3","wrong",{expectRevision:0});throw Error("pending commit replaced");}catch(e){if(e.message==="pending commit replaced")throw e;}
  await s.put("note/2",{text:"two"},{expectRevision:0});
  await s.get("missing");await s.put("note/3","three",{expectRevision:0});return {ok:true};
 }
 return {record:await s.put("note/1","one",{expectRevision:0})};
}};`;

/** One packed block through real assembly, with a scripted, credentialed HTTP transport. */
async function fixture(
  options: {
    credential?: boolean;
    v1?: boolean;
    effect?: boolean;
    context?: "project" | "device";
  } = {},
) {
  const s = fx.sandbox();
  const clock = fx.clock(NOW);
  const records = new Map<string, StateRecord>();
  const calls: (StateReadRequest | StateCommitRequest)[] = [];
  const bytes: string[] = [];
  const accepted = new Map<string, object>();
  let revision = 0;
  let lose = false;
  let deny: string | undefined;
  let conflict = false;
  let aborted = false;
  const net = fx.network(({ body, init }) => {
    const call = body as StateReadRequest | StateCommitRequest;
    calls.push(call);
    bytes.push(init.body!);
    expect(init.signal).toBeDefined();
    aborted = init.signal?.aborted ?? false;
    if (deny)
      return fx.json(
        {
          ok: false,
          status: "FAIL",
          error: { code: deny, message: "refused", retry: "never" },
          warnings: [],
        },
        deny === "AUTH_FORBIDDEN" ? 403 : 409,
      );
    const facts = () => ({
      version: 1,
      project: fx.PROJECT,
      namespace,
      policyRevision: "policy-1",
      readVersion: { epoch: "epoch-1", revision },
    });
    const ok = (result: unknown) =>
      fx.json({ ok: true, status: "OK", warnings: [], result });
    if (call.kind === "commit") {
      const previous = accepted.get(call.requestId);
      if (previous) return ok(previous);
      if (conflict) {
        conflict = false;
        revision++;
        return fx.json(
          {
            ok: false,
            status: "FAIL",
            error: {
              code: "REVISION_CONFLICT",
              message: "changed",
              retry: "never",
            },
            warnings: [],
          },
          409,
        );
      }
      expect(call.readVersion.revision).toBe(revision);
      const written = call.entries.map((entry) => {
        revision++;
        const record = {
          namespace,
          key: entry.key,
          value: entry.value,
          revision: (records.get(entry.key)?.revision ?? 0) + 1,
          updatedAt: new Date(NOW).toISOString(),
          updatedBy: actor,
        };
        records.set(entry.key, record);
        return record;
      });
      const result = {
        ...facts(),
        requestId: call.requestId,
        records: written,
        result: null,
      };
      accepted.set(call.requestId, result);
      if (lose && written[0]?.key === "note/2") {
        lose = false;
        throw Error("lost response");
      }
      return ok(result);
    }
    if (call.readVersion) expect(call.readVersion.revision).toBe(revision);
    const q = call.query;
    const result =
      q.kind === "get"
        ? { kind: q.kind, record: records.get(q.key) ?? null }
        : q.kind === "range"
          ? { kind: q.kind, records: [], next: null }
          : q.kind === "history"
            ? { kind: q.kind, events: [], next: null }
            : { kind: q.kind, value: records.size };
    return ok({ ...facts(), result });
  });
  const block = join(s.root, "probe");
  mkdirSync(block);
  const version = options.v1 ? 1 : 2;
  writeFileSync(
    join(block, "forge.block.json"),
    JSON.stringify({
      schemaVersion: "forge.block/1",
      id: namespace,
      version: "1.0.0",
      authorAbi: "forge.author/v2",
      profile: "trusted-action/v2",
      entry: "index.cjs",
      docs: "docs.json",
      requires: [
        { slot: "records", interface: `forge.state@${version}` },
        { slot: "levels", interface: `forge.project-state@${version}` },
      ],
      operations: {
        "probe.run": {
          input: "value.json",
          output: "value.json",
          context: options.context ?? "device",
          effects: options.effect === false ? [] : ["probe:write"],
          timeoutMs: 10000,
          idempotent: false,
          callers: ["human"],
          stability: "experimental",
        },
      },
    }),
  );
  writeFileSync(join(block, "value.json"), "{}");
  writeFileSync(
    join(block, "docs.json"),
    '{"operations":{"probe.run":{"title":"Probe","summary":"Bound async state probe."}}}',
  );
  writeFileSync(join(block, "index.cjs"), body);
  const env = { HOME: s.home, FORGE_DEVICE_ID: "dev-1" };
  const open = (root = s.root) =>
    createAssembly({
      root,
      deviceRoot: s.deviceRoot,
      providers: { env, cloudLogin: { fetch: net.fetch, now: clock.now } },
    });
  let assembly = await open();
  let sequence = 0;
  const call = (op: string, input: unknown) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `bound-${++sequence}`,
      op,
      input,
      caller: "human",
      context: {
        actor,
        device: { id: s.deviceRoot },
        project: { id: assembly.root, root: assembly.root },
      },
    });
  const added = await call("block.add", { path: "./probe" });
  if (!added.ok) throw Error(JSON.stringify(added));
  const { digest } = added.result as { digest: string };
  expect((await relay(call, "block.admit", { digest })).ok).toBe(true);
  expect(
    (
      await relay(call, "config.grant", {
        digest,
        effects: options.effect === false ? [] : ["probe:write"],
      })
    ).ok,
  ).toBe(true);
  if (options.credential !== false)
    await credentialStore(openCloudFiles(s.home)).save(fx.entry(NOW));
  writeFileSync(s.binding, JSON.stringify(fx.bindingFor()));
  return {
    s,
    calls,
    bytes,
    records,
    clock,
    open,
    call,
    probe: (input: object = {}) => call("probe.run", input),
    lose: () => {
      lose = true;
    },
    deny: (code: string) => {
      deny = code;
    },
    conflict: () => {
      conflict = true;
    },
    aborted: () => aborted,
    async replace(root: string) {
      await assembly.close();
      assembly = await open(root);
    },
    async close() {
      await assembly.close();
      s.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const success = (result: ResultEnvelope) => {
  expect(result).toMatchObject({ ok: true, status: "OK" });
  expect(exitCode(result)).toBe(0);
  if (!result.ok) throw Error(JSON.stringify(result));
  return result.result;
};
const failure = (result: ResultEnvelope, code: string, exit = 1) => {
  expect(result).toMatchObject({ ok: false, error: { code } });
  expect(exitCode(result)).toBe(exit);
};

const rows: readonly [string, (f: Fixture) => Promise<void>][] = [
  [
    "Own project",
    async (f) => {
      const acquire = spyOn(LocalState.prototype, "acquire").mockImplementation(
        () => {
          throw Error("local acquisition before bound selection");
        },
      );
      try {
        expect(success(await f.probe({ mode: "identity" }))).toMatchObject({
          id: prefix,
        });
        success(await f.probe());
        expect(f.records.get("note/1")?.value).toBe("one");
        expect(acquire).not.toHaveBeenCalled();
      } finally {
        acquire.mockRestore();
      }
      expect(existsSync(join(f.s.root, ".forge", "state.sqlite"))).toBe(false);
      // A different checkout with the same committed manifest and config has the same prefix.
      const clone = join(f.s.dir, "clone");
      const { cpSync } = await import("node:fs");
      cpSync(f.s.root, clone, { recursive: true });
      await f.replace(clone);
      expect(success(await f.probe({ mode: "identity" }))).toMatchObject({
        id: prefix,
      });
      expect(existsSync(join(clone, ".forge", "state.sqlite"))).toBe(false);
    },
  ],
  [
    "Explicit device",
    async (f) => {
      success(await f.probe({ device: true }));
      expect(f.calls).toHaveLength(0);
      expect(existsSync(join(f.s.root, ".forge", "state.sqlite"))).toBe(false);
    },
  ],
  [
    "Read plan",
    async (f) => {
      success(await f.probe({ mode: "plan" }));
      const commits = f.calls.filter((c) => c.kind === "commit");
      expect(commits).toHaveLength(2);
      expect(commits[0]!.readSet).toContainEqual({
        namespace,
        key: "missing",
        expectRevision: 0,
        readVersion: { epoch: "epoch-1", revision: 0 },
      });
      expect(commits[1]!.readSet).toEqual([]);
      expect(
        f.calls.filter((c) => c.kind === "read").map((c) => c.query.kind),
      ).toEqual(["get", "range", "count", "max", "count"]);
      expect(commits[1]!.readVersion.revision).toBe(1);
      f.conflict();
      success(await f.probe({ mode: "conflict" }));
      const reads = f.calls.filter(
        (c) => c.kind === "read" && c.query.kind === "get",
      );
      expect(reads.at(-1)!.readVersion).toBeUndefined();
    },
  ],
  [
    "Sub-requests",
    async (f) => {
      f.lose();
      success(await f.probe({ mode: "replay" }));
      const commits = f.calls.flatMap((c, i) =>
        c.kind === "commit" ? [{ c, bytes: f.bytes[i] }] : [],
      );
      expect(commits).toHaveLength(4);
      expect(new Set(commits.map(({ c }) => c.requestId)).size).toBe(3);
      expect(commits[1]!.bytes).toBe(commits[2]!.bytes);
      expect(commits[1]!.c.entries[0]!.value).toEqual({ text: "two" });
      expect(f.records.size).toBe(3);
      const afterReplay = f.calls[f.calls.indexOf(commits[2]!.c) + 1]!;
      expect(afterReplay.kind).toBe("read");
      expect(afterReplay.readVersion).toBeUndefined();
    },
  ],
  [
    "Outage/denied namespace",
    async (f) => {
      f.deny("AUTH_FORBIDDEN");
      failure(await f.probe(), "AUTH_FORBIDDEN");
      expect(f.records.size).toBe(0);
      expect(existsSync(join(f.s.root, ".forge", "state.sqlite"))).toBe(false);
    },
  ],
  [
    "Peer binding",
    async (f) => {
      const peer = join(f.s.dir, "peer");
      mkdirSync(join(peer, ".forge"), { recursive: true });
      writeFileSync(
        join(peer, ".forge", "project.json"),
        JSON.stringify({ schema: 1, id: fx.PROJECT_ID }),
      );
      writeFileSync(
        join(peer, ".forge", "cloud.json"),
        JSON.stringify(fx.bindingFor()),
      );
      // The registry points at historical state, deliberately invalid SQLite: opening it must fail.
      writeFileSync(
        join(peer, ".forge", "state.sqlite"),
        "historical, must not open",
      );
      const device = new LocalState(join(f.s.deviceRoot, "records.sqlite"));
      const owner = (await device.open(true))!;
      owner.put(
        "forge/core-projects",
        `project/${prefix}`,
        { name: "peer", root: peer },
        actor,
        { expectRevision: 0 },
      );
      await device.close();
      expect(success(await f.probe({ mode: "peer", ref: "peer" }))).toEqual({
        status: "unavailable",
      });
      expect(f.calls).toHaveLength(0);
    },
  ],
  [
    "Lifetime/effect",
    async (f) => {
      failure(await f.probe(), "GRANT_REQUIRED", 2);
      expect(f.calls).toHaveLength(0);
      expect(f.aborted()).toBe(false);
    },
  ],
];
for (const [name, run] of rows)
  test(name, async () => {
    const f = await fixture(
      name === "Explicit device"
        ? { credential: false }
        : name === "Lifetime/effect"
          ? { effect: false }
          : {},
    );
    try {
      await run(f);
    } finally {
      await f.close();
    }
  });

for (const context of ["project", "device"] as const)
  test(`real ${context} state binding selects before local registration`, async () => {
    const f = await fixture({ context });
    try {
      success(await f.probe({ device: context === "project" }));
      expect(f.calls.some((c) => c.kind === "commit")).toBe(true);
      expect(existsSync(join(f.s.root, ".forge", "state.sqlite"))).toBe(false);
    } finally {
      await f.close();
    }
  });

test("a v1 writer remains refused without opening project state", async () => {
  const f = await fixture({ v1: true, context: "project" });
  try {
    failure(await f.probe(), "UNAVAILABLE");
    expect(f.calls).toHaveLength(0);
    expect(existsSync(join(f.s.root, ".forge", "state.sqlite"))).toBe(false);
  } finally {
    await f.close();
  }
});
