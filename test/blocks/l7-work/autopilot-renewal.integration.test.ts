// [integration] The runtime guard on `lane record` with `replaces`, against the real approval store and clock.
import {
  expect,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import type { AmbientContext } from "../../../src/generated/types.ts";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";

setDefaultTimeout(60_000);
const DAY = 24 * 60 * 60 * 1000;
// The runtime refuses with this; anything else came from the work block, which has no ask here.
const NOT_SPENT = /not expired or used/;
const PAST_RUNTIME = /no open gated ask/;

async function open(rename = {}) {
  const folder = mkdtempSync(join(tmpdir(), "forge-renewal-"));
  const root = join(folder, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        work: {
          rename,
          source: { builtin: "forge/work" },
          config: { idPrefix: "sample" },
        },
      },
    }),
  );
  // The work block ships as a .cts source; stage it the way the build emits it.
  const source = fileURLToPath(firstPartyBlocks["forge/work"]!);
  const target = join(folder, "builtins", "work");
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.endsWith(".cts"),
  });
  writeFileSync(
    join(target, "entry.cjs"),
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      readFileSync(join(source, "entry.cts"), "utf8"),
    ),
  );
  const original = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    original(path === source ? target : path),
  );
  try {
    const assembly = await createAssembly({
      root,
      deviceRoot: join(folder, "device"),
    });
    let counter = 0;
    return {
      invoke(op: string, input: unknown, ambient: AmbientContext = {}) {
        const { caller, context } = localCall(assembly);
        counter += 1;
        return assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: `renewal-${counter}`,
          op,
          input,
          caller,
          context: { ...context, ...ambient },
        });
      },
      async close() {
        try {
          await assembly.close();
        } finally {
          capture.mockRestore();
          rmSync(folder, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    capture.mockRestore();
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

test("renamed attempts receive real assembly grants and ignore ambient generations", async () => {
  const h = await open({ issue: "ticket", attempt: "try" });
  try {
    for (const [op, input] of [
      ["ticket.create", { title: "Attempt" }],
      ["ticket.claim", { id: "sample-1" }],
      ["try.slots", { id: "sample-1", count: 1 }],
      ["try.reserve", { id: "sample-1" }],
      ["try.note", { id: "sample-1", attempt: "attempt-1", body: "note" }],
      ["try.release", { id: "sample-1", attempt: "attempt-1" }],
    ] as const) {
      const result = await h.invoke(op, input, {
        session: { id: "attempts" },
        leaseGeneration: 2,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
  } finally {
    await h.close();
  }
}, 30_000);

test("a request is replaced only once it is used or expired, by the real approval store and clock", async () => {
  const h = await open();
  try {
    const created = await h.invoke("issue.create", { title: "Lane" });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const id = String((created.result as { id: string }).id);
    const scope = { id };
    // A bare resume stores a pending request and returns its id.
    const ask = async (): Promise<string> => {
      const bare = await h.invoke("lane.resume", scope);
      expect(bare.ok).toBe(false);
      return String((bare.result as { request: { id: string } }).request.id);
    };
    const record = async (request: string, replaces: string) =>
      JSON.stringify(
        await h.invoke("lane.record", { id, request, scope, replaces }),
      );

    // Pending and unexpired: the runtime refuses to let a new request replace it.
    const pending = await ask();
    const next = await ask();
    expect(await record(next, pending)).toMatch(NOT_SPENT);
    // A request that does not exist is not spent either.
    expect(await record(next, "no-such-request")).toMatch(NOT_SPENT);

    // Used: a real approval burns the request, then it may be replaced.
    const used = await ask();
    const resumed = await h.invoke("lane.resume", {
      ...scope,
      approval: {
        request: used,
        quote: "yes, resume it",
        source: { harness: "codex", thread: "owner-chat", message: "m1" },
      },
    });
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    const afterUsed = await record(next, used);
    expect(afterUsed).not.toMatch(NOT_SPENT);
    expect(afterUsed).toMatch(PAST_RUNTIME);

    // Expired: a day and an hour later the old pending request is dead, and a new one replaces it.
    setSystemTime(new Date(Date.now() + DAY + 60 * 60 * 1000));
    const late = await ask();
    const afterExpiry = await record(late, pending);
    expect(afterExpiry).not.toMatch(NOT_SPENT);
    expect(afterExpiry).toMatch(PAST_RUNTIME);
    // The new request itself is checked like any other: an expired one is not accepted.
    expect(await record(next, pending)).toMatch(
      /not a pending approval request/,
    );
  } finally {
    setSystemTime();
    await h.close();
  }
});
