import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { AGENT_MARKERS } from "../../src/assembly/identity.ts";
import { LocalState } from "../../src/assembly/state.ts";
import { dispatch, record } from "../../src/surface/dispatch.ts";

const MARKERS = [...AGENT_MARKERS, "FORGE_HARNESS"];
const saved = MARKERS.map((key) => [key, process.env[key]] as const);
beforeEach(() => {
  for (const key of MARKERS) delete process.env[key];
});
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function open(
  project: boolean,
  terminal?: NonNullable<Parameters<typeof createAssembly>[0]["terminal"]>,
) {
  const work = mkdtempSync(join(tmpdir(), "forge-owner-policy-"));
  const root = join(work, "project");
  const deviceRoot = join(work, "device");
  mkdirSync(root);
  mkdirSync(deviceRoot);
  cpSync(
    resolve(import.meta.dirname, "../../examples/hello-block"),
    join(root, "hello"),
    { recursive: true },
  );
  const assembly = await createAssembly({
    root,
    deviceRoot,
    project,
    ...(terminal === undefined ? {} : { terminal }),
  });
  const options = localCall(assembly);
  return {
    work,
    deviceRoot,
    assembly,
    call: (op: string, input: unknown) =>
      dispatch(assembly.catalog, op, input, options),
    policy: (unattended: string[]) =>
      writeFileSync(
        join(deviceRoot, "owner.json"),
        JSON.stringify({ unattended }),
      ),
  };
}

test("unattended block admission follows owner.json and is logged as scripts-policy", async () => {
  const h = await open(false);
  try {
    h.policy(["block.admit"]);
    const added = await h.call("block.add", { path: "./hello" });
    const digest = String(record(added.result)?.digest);
    expect(await h.call("block.admit", { digest })).toMatchObject({
      ok: true,
      result: { admitted: true },
    });
    expect(await h.call("hello.say", { name: "Owner" })).toMatchObject({
      ok: true,
    });
    await h.assembly.close();
    const trust = new LocalState(join(h.deviceRoot, "trust.sqlite"));
    try {
      const rows = (await trust.open(false))?.list("forge/core-approvals");
      expect(rows?.map((row) => record(row.value)?.method)).toEqual([
        "scripts-policy",
      ]);
      expect(String(record(rows?.[0]?.value)?.ask)).toContain("Admit block");
    } finally {
      await trust.close();
    }
  } finally {
    rmSync(h.work, { recursive: true, force: true });
  }
}, 30_000);

test("an agent session ignores owner.json", async () => {
  const h = await open(false);
  try {
    h.policy(["block.admit", "config.grant"]);
    process.env.CLAUDE_CODE_SESSION_ID = "agent-session";
    const added = await h.call("block.add", { path: "./hello" });
    const digest = String(record(added.result)?.digest);
    expect(await h.call("block.admit", { digest })).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_REQUIRED" },
    });
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(await h.call("hello.say", { name: "Owner" })).toMatchObject({
      ok: false,
      error: { code: "ADMISSION_REQUIRED" },
    });
  } finally {
    await h.assembly.close();
    rmSync(h.work, { recursive: true, force: true });
  }
}, 30_000);

test("owner.json never makes store recovery eligible", async () => {
  const h = await open(true);
  try {
    h.policy(["store.reinit", "owner.policy", "block.admit"]);
    expect(await h.call("store.reinit", {})).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_REQUIRED" },
    });
  } finally {
    await h.assembly.close();
    rmSync(h.work, { recursive: true, force: true });
  }
}, 30_000);

test("owner.policy needs a relayed approval and then writes owner.json", async () => {
  const h = await open(false);
  try {
    const input = { unattended: ["block.admit", "config.grant"] };
    const first = await h.call("owner.policy", input);
    expect(first).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_REQUIRED" },
    });
    const request = String(record(record(first.result)?.request)?.id);
    expect(
      await h.call("owner.policy", {
        ...input,
        approval: {
          request,
          quote: "yes",
          source: { harness: "codex", thread: "owner-chat" },
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      JSON.parse(readFileSync(join(h.deviceRoot, "owner.json"), "utf8")),
    ).toEqual(input);
  } finally {
    await h.assembly.close();
    rmSync(h.work, { recursive: true, force: true });
  }
}, 30_000);

test("FORGE_HARNESS=local-cli does not hide an agent session from the policy", async () => {
  for (const marker of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) {
    const h = await open(false);
    try {
      h.policy(["block.admit"]);
      process.env.FORGE_HARNESS = "local-cli";
      process.env[marker] = "agent-session";
      const added = await h.call("block.add", { path: "./hello" });
      const digest = String(record(added.result)?.digest);
      expect(await h.call("block.admit", { digest })).toMatchObject({
        ok: false,
        error: { code: "APPROVAL_REQUIRED" },
      });
    } finally {
      delete process.env[marker];
      delete process.env.FORGE_HARNESS;
      await h.assembly.close();
      rmSync(h.work, { recursive: true, force: true });
    }
  }
}, 30_000);

test("a malformed owner.json is ignored and says so", async () => {
  const h = await open(false);
  try {
    writeFileSync(
      join(h.deviceRoot, "owner.json"),
      '{"unattended":["block.admit",42]}',
    );
    const added = await h.call("block.add", { path: "./hello" });
    const digest = String(record(added.result)?.digest);
    const refused = await h.call("block.admit", { digest });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_REQUIRED" },
    });
    expect(JSON.stringify(refused)).toContain("owner.json was ignored");
  } finally {
    await h.assembly.close();
    rmSync(h.work, { recursive: true, force: true });
  }
}, 30_000);

test("an attended approval uses the host's configured terminal, not the process's", async () => {
  const asked: string[][] = [];
  for (const stdin of [true, false]) {
    const h = await open(false, {
      tty: () => ({ stdin, stderr: true }),
      confirm: (op, ask) => {
        asked.push([op, ask]);
        return Promise.resolve(true);
      },
    });
    try {
      const added = await h.call("block.add", { path: "./hello" });
      const digest = String(record(added.result)?.digest);
      const admitted = await h.call("block.admit", { digest });
      if (stdin) {
        expect(admitted).toMatchObject({ ok: true });
        await h.assembly.close();
        const trust = new LocalState(join(h.deviceRoot, "trust.sqlite"));
        try {
          const rows = (await trust.open(false))?.list("forge/core-approvals");
          expect(rows?.map((row) => record(row.value)?.method)).toEqual([
            "attended",
          ]);
        } finally {
          await trust.close();
        }
      } else {
        expect(admitted).toMatchObject({
          ok: false,
          error: { code: "APPROVAL_REQUIRED" },
        });
        await h.assembly.close();
      }
    } finally {
      rmSync(h.work, { recursive: true, force: true });
    }
  }
  expect(asked).toHaveLength(1);
  expect(asked[0]?.[0]).toBe("block.admit");
  expect(asked[0]?.[1]).toContain("Admit block");
}, 30_000);
