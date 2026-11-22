import {
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { AGENT_MARKERS } from "../../src/assembly/identity.ts";
import { PROJECT_MANIFEST } from "../../src/assembly/project-manifest.ts";
import { LocalState } from "../../src/assembly/state.ts";
import { dispatch, record } from "../../src/surface/dispatch.ts";
import { exitCode } from "../../src/surface/result.ts";

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
  rootName = "project",
) {
  const work = mkdtempSync(join(tmpdir(), "forge-owner-policy-"));
  const root = join(work, rootName);
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
        { mode: 0o600 },
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
        const unattended = ["block.admit", "config.grant"];
        expect(await h.call("owner.policy", { unattended })).toMatchObject({
          ok: true,
          result: { unattended },
        });
        expect(
          await h.call("config.grant", { digest, effects: [] }),
        ).toMatchObject({ ok: true });
        expect(readFileSync(join(h.deviceRoot, "owner.json"), "utf8")).toBe(
          `${JSON.stringify({ unattended })}\n`,
        );
        await h.assembly.close();
        const trust = new LocalState(join(h.deviceRoot, "trust.sqlite"));
        try {
          const rows = (await trust.open(false))?.list("forge/core-approvals");
          expect(rows?.map((row) => record(row.value)?.method)).toEqual([
            "attended",
            "attended",
            "attended",
          ]);
          expect(
            rows?.map((row) => String(record(row.value)?.ask)).sort(),
          ).toEqual([
            `Admit block example.org/hello at ${digest} so its captured code can run. Declared effects: none.`,
            `Grant effects none to block example.org/hello at ${digest}.`,
            "Let scripts and CI with no agent session run block.admit, config.grant without asking, by writing owner.json in the device folder.",
          ]);
        } finally {
          await trust.close();
        }
        expect(asked.map(([, ask]) => ask)).toEqual([
          `Admit block "example.org/hello" at "${digest}" so its captured code can run. Declared effects: none.`,
          'Let scripts and CI with no agent session run "block.admit", "config.grant" without asking, by writing owner.json in the device folder.',
          `Grant effects none to block "example.org/hello" at "${digest}".`,
        ]);
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
  expect(asked.map(([op]) => op)).toEqual([
    "block.admit",
    "owner.policy",
    "config.grant",
  ]);
}, 30_000);

test.each(["project.init", "store.reinit"])(
  "%s shows the quoted root while writing to the original path",
  async (op) => {
    const asks: string[] = [];
    let attended = false;
    const rootName = "project\u2028\u2029\u202e";
    const h = await open(
      true,
      {
        tty: () => ({ stdin: attended, stderr: attended }),
        confirm: (_op, ask) => {
          asks.push(ask);
          return Promise.resolve(true);
        },
      },
      rootName,
    );
    const root = join(h.work, rootName);
    const trust = new LocalState(join(h.deviceRoot, "trust.sqlite"));
    try {
      const pending = await h.call(op, {});
      expect(pending).toMatchObject({
        ok: false,
        status: "FAIL",
        error: { code: "APPROVAL_REQUIRED" },
      });
      expect(exitCode(pending)).toBe(1);
      const request = record(record(pending.result)?.request);
      const file =
        op === "project.init" ? PROJECT_MANIFEST : ".forge/state.sqlite";
      expect(existsSync(join(root, file))).toBe(false);
      attended = true;
      expect(exitCode(await h.call(op, {}))).toBe(0);
      expect(existsSync(join(root, file))).toBe(true);
      const stored = (await trust.open(false))?.list("forge/core-approvals");
      const pendingRow = stored?.find((row) => row.key === request?.id)?.value;
      const rawAsk = (target: string) =>
        op === "project.init"
          ? `Create ${PROJECT_MANIFEST} with a new random project id for ${target}. The id is never changed by init.`
          : `Start a new empty Forge store for ${target}. Existing records will not be recovered.`;
      expect(pendingRow).toMatchObject({
        ask: rawAsk(root),
        binding: request?.binding,
        status: "pending",
      });
      expect(stored?.map((row) => row.value)).toContainEqual(
        expect.objectContaining({
          ask: rawAsk(root),
          binding: request?.binding,
          method: "attended",
        }),
      );
      const displayedRoot = JSON.stringify(root).replace(
        "\u2028\u2029\u202e",
        "\\u2028\\u2029\\u202e",
      );
      expect([request?.ask, ...asks]).toEqual([
        rawAsk(displayedRoot),
        rawAsk(displayedRoot),
      ]);
    } finally {
      await trust.close();
      await h.assembly.close();
      rmSync(h.work, { recursive: true, force: true });
    }
  },
  30_000,
);

// The platform-conditional tests below take the same 30 s as the rest of this file.
setDefaultTimeout(30_000);

test.skipIf(process.platform === "win32")(
  "owner.policy writes a private owner.json over a broader one",
  async () => {
    const h = await open(false);
    try {
      const path = join(h.deviceRoot, "owner.json");
      writeFileSync(path, "{}");
      chmodSync(path, 0o664);
      const input = { unattended: ["block.admit"] };
      const first = await h.call("owner.policy", input);
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
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      await h.assembly.close();
      rmSync(h.work, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "a group-writable owner.json is ignored whole",
  async () => {
    const h = await open(false);
    try {
      h.policy(["block.admit"]);
      chmodSync(join(h.deviceRoot, "owner.json"), 0o664);
      const added = await h.call("block.add", { path: "./hello" });
      const digest = String(record(added.result)?.digest);
      const refused = await h.call("block.admit", { digest });
      expect(refused).toMatchObject({
        ok: false,
        error: { code: "APPROVAL_REQUIRED" },
      });
      expect(JSON.stringify(refused)).toContain("group- or world-writable");
    } finally {
      await h.assembly.close();
      rmSync(h.work, { recursive: true, force: true });
    }
  },
  30_000,
);
