import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packedConsumer } from "../../integration/packed-consumer.ts";

const consumer = process.env.FORGE_PACKED_CONSUMER
  ? packedConsumer()
  : undefined;
const repo = consumer
  ? join(consumer, "node_modules/forge-workflow")
  : resolve(import.meta.dirname, "../../..");
const modules = join(consumer ?? repo, "node_modules");
type Envelope = {
  ok: boolean;
  result?: { id: string; status?: string; lease?: Lease };
  error?: { code: string; message: string; lease?: Lease };
};
type Lease = {
  expiresAt: string;
  holder: {
    actor: { kind: string; id: string };
    session: { id: string; device: string; agent: string; harness: string };
  };
};

function fixture(bin = join(repo, "dist/bin/forge.js")) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-session-")));
  const device = join(root, "device");
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        work: { source: { builtin: "forge/work" }, bind: { state: "core" } },
      },
    }),
  );
  const base: NodeJS.ProcessEnv = { ...process.env, FORGE_DEVICE_ROOT: device };
  for (const key of [
    "FORGE_SESSION",
    "FORGE_AGENT",
    "FORGE_HARNESS",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
  ])
    delete base[key];
  function cli(
    verb: string,
    input: object,
    env: NodeJS.ProcessEnv = {},
    expected: boolean | null = true,
  ) {
    const result = spawnSync(
      "node",
      [bin, "issue", verb, "--input", JSON.stringify(input)],
      {
        cwd: root,
        env: { ...base, ...env },
        encoding: "utf8",
        windowsHide: true,
        timeout: 20000,
      },
    );
    expect(result.error).toBeUndefined();
    const envelope = JSON.parse(result.stdout) as Envelope;
    if (expected !== null) {
      expect(envelope.ok, result.stdout + result.stderr).toBe(expected);
      expect(result.status === 0, result.stdout + result.stderr).toBe(expected);
    }
    return envelope;
  }
  const create = () =>
    cli("create", { title: "Disposable session identity acceptance" }).result!
      .id;
  const close = (
    id: string,
    env: NodeJS.ProcessEnv = {},
    expected: boolean | null = true,
  ) =>
    cli(
      "close",
      { id, withoutReceipt: "Disposable CLI acceptance fixture" },
      env,
      expected,
    );
  return {
    root,
    device,
    cli,
    create,
    close,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function foreignWritesRefused(
  f: ReturnType<typeof fixture>,
  id: string,
  env: NodeJS.ProcessEnv,
) {
  // Execute both writes before asserting so a regression exposes both authority paths.
  const renewed = f.cli("renew", { id }, env, null);
  const closed = f.close(id, env, null);
  for (const result of [renewed, closed])
    expect(result).toMatchObject({
      ok: false,
      error: { code: "LEASE_NOT_HELD" },
    });
}

for (const [variable, harness] of [
  ["CLAUDE_CODE_SESSION_ID", "claude-code"],
  ["CODEX_THREAD_ID", "codex"],
] as const) {
  test(`CLI ${harness}: separate sessions cannot renew or close another session's claim`, () => {
    const f = fixture();
    try {
      const inherited =
        harness === "codex" ? { CLAUDE_CODE_SESSION_ID: "parent-session" } : {};
      const first = {
        ...inherited,
        [variable]: "session-one",
        FORGE_AGENT: "first-agent",
      };
      const second = { ...inherited, [variable]: "session-two" };
      const id = f.create();
      f.cli("claim", { id, ttlSeconds: 60 }, first);
      const refused = f.cli("claim", { id }, second, false);
      expect(refused.error?.code).toBe("LEASE_HELD");
      foreignWritesRefused(f, id, second);
      const lease = f.cli("show", { id }).result?.lease;
      expect(lease?.holder.session).toEqual({
        id: "session-one",
        device: f.device,
        agent: "first-agent",
        harness,
      });
      expect(refused.error?.lease).toEqual(lease);
      for (const diagnostic of [
        f.device,
        "first-agent",
        harness,
        "session-one",
        lease!.expiresAt,
      ])
        expect(refused.error?.message).toContain(diagnostic);
      f.cli("renew", { id, ttlSeconds: 120 }, first);
      f.close(id, first);
      expect(f.cli("show", { id }).result?.status).toBe("closed");
    } finally {
      f.cleanup();
    }
  }, 90000);
}

test("CLI session override survives harness and agent switches; native Codex alias and manual fallback remain stable", () => {
  const f = fixture();
  try {
    for (const [env, expectedId, expectedHarness] of [
      [
        {
          FORGE_SESSION: "chat",
          CLAUDE_CODE_SESSION_ID: "native",
          CODEX_THREAD_ID: "thread",
          FORGE_HARNESS: "custom",
          FORGE_AGENT: "owner",
        },
        "chat",
        "custom",
      ],
      [
        { CLAUDE_CODE_SESSION_ID: "claude", CODEX_THREAD_ID: "thread" },
        "thread",
        "codex",
      ],
      [
        { CODEX_THREAD_ID: "thread", CODEX_SESSION_ID: "old" },
        "thread",
        "codex",
      ],
      [{ CODEX_SESSION_ID: "old" }, "old", "codex"],
      [{}, "local-cli", "local-cli"],
    ] as const) {
      const id = f.create();
      f.cli("claim", { id }, env);
      const lease = f.cli("show", { id }).result?.lease;
      expect(lease?.holder.actor).toEqual({ kind: "human", id: "local-cli" });
      expect(lease?.holder.session).toEqual({
        id: expectedId,
        device: f.device,
        harness: expectedHarness,
        agent: "FORGE_AGENT" in env ? env.FORGE_AGENT : expectedHarness,
      });
      const next =
        expectedId === "chat"
          ? {
              FORGE_SESSION: "chat",
              CODEX_THREAD_ID: "different-native",
              FORGE_HARNESS: "codex",
              FORGE_AGENT: "replacement",
            }
          : env;
      f.cli("renew", { id }, next);
      f.close(id, next);
      expect(f.cli("show", { id }).result?.status).toBe("closed");
    }
  } finally {
    f.cleanup();
  }
}, 150000);

test("CLI device plus session fences matching session names from another device", () => {
  const f = fixture();
  try {
    const id = f.create();
    const first = { FORGE_SESSION: "shared-name" };
    const second = {
      FORGE_SESSION: "shared-name",
      FORGE_DEVICE_ROOT: join(f.root, "other-device"),
    };
    f.cli("claim", { id }, first);
    foreignWritesRefused(f, id, second);
    f.cli("renew", { id }, first);
    f.close(id, first);
    expect(f.cli("show", { id }).result?.status).toBe("closed");
  } finally {
    f.cleanup();
  }
}, 90000);

test("removing native session resolution makes the CLI authority journey fail", () => {
  const copy = mkdtempSync(join(tmpdir(), "forge-session-counterfactual-"));
  try {
    cpSync(join(repo, "dist"), join(copy, "dist"), { recursive: true });
    copyFileSync(join(repo, "package.json"), join(copy, "package.json"));
    symlinkSync(modules, join(copy, "node_modules"), "junction");
    const target = join(copy, "dist/src/assembly/index.js");
    const original = readFileSync(target, "utf8");
    const native =
      /process\.env\.CODEX_THREAD_ID \|\|\s*process\.env\.CODEX_SESSION_ID \|\|\s*process\.env\.CLAUDE_CODE_SESSION_ID \|\|/;
    expect(original).toMatch(native);
    writeFileSync(target, original.replace(native, ""));
    const f = fixture(join(copy, "dist/bin/forge.js"));
    try {
      const id = f.create();
      f.cli("claim", { id }, { CODEX_THREAD_ID: "first" });
      expect(() =>
        foreignWritesRefused(f, id, { CODEX_THREAD_ID: "second" }),
      ).toThrow();
    } finally {
      f.cleanup();
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 90000);
