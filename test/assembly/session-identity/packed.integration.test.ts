import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packedConsumer } from "../../integration/packed-consumer.ts";

const consumer = process.env.FORGE_PACKED_CONSUMER
  ? packedConsumer()
  : undefined;
const repo = consumer
  ? join(consumer, "node_modules/forge-workflow")
  : resolve(import.meta.dirname, "../../..");
const bin = join(repo, "dist/bin/forge.js");
type Session = {
  id: string;
  device?: string;
  agent?: string;
  harness?: string;
};
type Lease = {
  expiresAt: string;
  holder: { actor: { kind: string; id: string }; session: Session };
};
type Envelope = {
  ok: boolean;
  result?: { id: string; status?: string; lease?: Lease };
  error?: { code: string; message: string; lease?: Lease };
};
type Event = {
  type: string;
  actor: { kind: string; id: string };
  data: { holder: { session: Session } };
};

function fixture() {
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
      mcp: { expose: ["issue"] },
    }),
  );
  const base: NodeJS.ProcessEnv = { ...process.env, FORGE_DEVICE_ROOT: device };
  for (const key of [
    "FORGE_SESSION",
    "FORGE_DEVICE_ID",
    "FORGE_AGENT",
    "FORGE_HARNESS",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CODEX_COMPANION_SESSION_ID",
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
  return {
    root,
    device,
    base,
    cli,
    create: () =>
      cli("create", { title: "Disposable session identity acceptance" }).result!
        .id,
    close: (
      id: string,
      env: NodeJS.ProcessEnv = {},
      expected: boolean | null = true,
    ) =>
      cli(
        "close",
        { id, withoutReceipt: "Disposable CLI acceptance fixture" },
        env,
        expected,
      ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function mcp(f: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv = {}) {
  const child = spawn("node", [bin, "--mcp"], {
    cwd: f.root,
    env: { ...f.base, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let next = 0,
    buffer = "",
    errors = "";
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"),
        line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      if (message.id === undefined) continue;
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    }
  });
  child.once("exit", (code) => {
    for (const request of pending.values())
      request.reject(new Error(`MCP exited ${code}: ${errors}`));
  });
  async function rpc(method: string, params: object) {
    const id = ++next;
    let timer: ReturnType<typeof setTimeout>;
    const response = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${errors}`));
      }, 20000);
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    try {
      return await response;
    } finally {
      clearTimeout(timer!);
    }
  }
  return {
    async initialize() {
      await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "session-identity-integration", version: "1.0.0" },
      });
      child.stdin.write(
        '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
      );
    },
    async call(name: string, args: object) {
      const result = (await rpc("tools/call", { name, arguments: args })) as {
        content: { text: string }[];
        structuredContent: unknown;
      };
      const envelope = JSON.parse(result.content[0]!.text) as Envelope;
      expect(result.structuredContent).toEqual(envelope);
      return envelope;
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function foreignWritesRefused(
  f: ReturnType<typeof fixture>,
  id: string,
  env: NodeJS.ProcessEnv,
) {
  const results = [
    f.cli("claim", { id }, env, null),
    f.cli("renew", { id }, env, null),
    f.close(id, env, null),
    f.cli("release", { id }, env, null),
  ];
  for (const [index, result] of results.entries()) {
    expect(result).toMatchObject({
      ok: false,
      error: { code: index === 0 ? "LEASE_HELD" : "LEASE_NOT_HELD" },
    });
  }
  return results;
}

test("CLI persisted device identity fences all holder writes after same-path device replacement without leaking paths", () => {
  const f = fixture();
  try {
    const id = f.create();
    f.cli("show", { id });
    expect(existsSync(join(f.device, "device-id"))).toBe(false);
    const owner = {
      FORGE_SESSION: "chat",
      FORGE_AGENT: "first-agent",
      FORGE_HARNESS: "custom",
    };
    f.cli("claim", { id }, owner);
    const deviceId = readFileSync(join(f.device, "device-id"), "utf8").trim();
    expect(deviceId).toMatch(/^device-[a-f0-9-]+$/);
    if (process.platform === "win32")
      f.cli(
        "renew",
        { id },
        { ...owner, FORGE_DEVICE_ROOT: f.device.toUpperCase() },
      );
    const lease = f.cli("show", { id }).result!.lease!;
    expect(lease.holder.session).toEqual({
      id: "chat",
      device: deviceId,
      agent: "first-agent",
      harness: "custom",
    });
    writeFileSync(join(f.device, "device-id"), "replacement-device\n");
    const refused = foreignWritesRefused(f, id, owner);
    for (const result of refused) {
      for (const label of [
        deviceId,
        "first-agent",
        "custom",
        "chat",
        lease.expiresAt,
      ])
        expect(result.error?.message).toContain(label);
      expect(JSON.stringify(result)).not.toContain(f.root);
      expect(JSON.stringify(result)).not.toContain(homedir());
    }
    expect(f.cli("show", { id }).result!.lease).toEqual(lease);
    f.close(id, { ...owner, FORGE_DEVICE_ID: `  ${deviceId}  ` });
  } finally {
    f.cleanup();
  }
}, 90000);

test("CLI native harness nesting isolates chats while Codex subagents share their root session", () => {
  const f = fixture();
  try {
    for (const [parent, child] of [
      [
        { CODEX_THREAD_ID: "thread" },
        { CODEX_THREAD_ID: "thread", CLAUDE_CODE_SESSION_ID: "claude" },
      ],
      [
        { CLAUDE_CODE_SESSION_ID: "claude" },
        { CODEX_THREAD_ID: "thread", CLAUDE_CODE_SESSION_ID: "claude" },
      ],
      [
        { CODEX_THREAD_ID: "thread" },
        { CODEX_THREAD_ID: "thread", CODEX_SESSION_ID: "alias" },
      ],
    ]) {
      const id = f.create();
      f.cli("claim", { id }, parent);
      const parentSession = f.cli("show", { id }).result!.lease!.holder.session
        .id;
      expect(f.cli("claim", { id }, child, false).error?.code).toBe(
        "LEASE_HELD",
      );
      expect(f.cli("renew", { id }, child, false).error?.code).toBe(
        "LEASE_NOT_HELD",
      );
      f.cli("release", { id }, parent);
      f.cli("claim", { id }, child);
      expect(f.cli("show", { id }).result!.lease!.holder.session.id).not.toBe(
        parentSession,
      );
      f.cli("release", { id }, child);
    }
    const id = f.create();
    f.cli(
      "claim",
      { id },
      { CODEX_SESSION_ID: "root-chat", CODEX_THREAD_ID: "parent-thread" },
    );
    const subagent = {
      CODEX_SESSION_ID: "root-chat",
      CODEX_THREAD_ID: "subagent-thread",
    };
    f.cli("renew", { id }, subagent);
    f.cli("release", { id }, subagent);
  } finally {
    f.cleanup();
  }
}, 120000);

test("CLI and MCP trim explicit session sharing, refresh holder labels and attribute renew/release to the current caller", async () => {
  const f = fixture();
  const server = mcp(f, {
    FORGE_SESSION: "  shared-chat  ",
    FORGE_AGENT: "mcp-agent",
    FORGE_HARNESS: "mcp-harness",
    CODEX_THREAD_ID: "ignored-mcp-native",
  });
  try {
    const id = f.create();
    const cli = {
      FORGE_SESSION: " shared-chat ",
      FORGE_AGENT: "cli-agent",
      FORGE_HARNESS: "cli-harness",
      CLAUDE_CODE_SESSION_ID: "ignored-cli-native",
      CODEX_COMPANION_SESSION_ID: "ignored-companion",
    };
    f.cli("claim", { id }, cli);
    await server.initialize();
    expect((await server.call("issue_renew", { id })).ok).toBe(true);
    expect(f.cli("show", { id }).result!.lease!.holder.session).toMatchObject({
      id: "shared-chat",
      agent: "mcp-agent",
      harness: "mcp-harness",
    });
    expect((await server.call("issue_release", { id })).ok).toBe(true);
    expect((await server.call("issue_claim", { id })).ok).toBe(true);
    f.cli("renew", { id }, cli);
    expect(f.cli("show", { id }).result!.lease!.holder.session).toMatchObject({
      id: "shared-chat",
      agent: "cli-agent",
      harness: "cli-harness",
    });
    f.cli("release", { id }, cli);
    const { events } = f.cli("events", { id }).result as unknown as {
      events: Event[];
    };
    const authorityEvents = events.filter((event) =>
      /lease\.(renewed|released)@1$/.test(event.type),
    );
    expect(
      authorityEvents.map((event) => ({
        actor: event.actor,
        agent: event.data.holder.session.agent,
        harness: event.data.holder.session.harness,
      })),
    ).toEqual([
      {
        actor: { kind: "agent", id: "mcp" },
        agent: "mcp-agent",
        harness: "mcp-harness",
      },
      {
        actor: { kind: "agent", id: "mcp" },
        agent: "mcp-agent",
        harness: "mcp-harness",
      },
      {
        actor: { kind: "human", id: "local-cli" },
        agent: "cli-agent",
        harness: "cli-harness",
      },
      {
        actor: { kind: "human", id: "local-cli" },
        agent: "cli-agent",
        harness: "cli-harness",
      },
    ]);
  } finally {
    await server.close();
    f.cleanup();
  }
}, 120000);

test("non-TTY CLI and MCP refuse claims without a session source and name FORGE_SESSION", async () => {
  const f = fixture();
  const server = mcp(f, {
    FORGE_SESSION: "  ",
    CODEX_THREAD_ID: " ",
    CODEX_COMPANION_SESSION_ID: "plugin-is-not-a-chat",
  });
  try {
    const id = f.create();
    const cli = f.cli(
      "claim",
      { id },
      {
        FORGE_SESSION: "  ",
        CODEX_THREAD_ID: " ",
        CODEX_COMPANION_SESSION_ID: "plugin-is-not-a-chat",
      },
      null,
    );
    await server.initialize();
    const tool = await server.call("issue_claim", { id });
    for (const result of [cli, tool]) {
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("FORGE_SESSION");
    }
    expect(f.cli("show", { id }).result?.lease).toBeUndefined();
    expect(existsSync(join(f.device, "device-id"))).toBe(false);
  } finally {
    await server.close();
    f.cleanup();
  }
}, 90000);

test("CLI upgrades legacy actor/session leases without requiring a generated device ID before renew, close or release", async () => {
  const f = fixture();
  try {
    const ids = [f.create(), f.create(), f.create()];
    const { createAssembly } = (await import(
      pathToFileURL(join(repo, "dist/src/assembly/index.js")).href
    )) as typeof import("../../../src/assembly/index.ts");
    const assembly = await createAssembly({
      root: f.root,
      deviceRoot: f.device,
    });
    try {
      for (const id of ids) {
        const seeded = await assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: `legacy-seed-${id}`,
          op: "issue.claim",
          input: { id },
          caller: "human",
          context: {
            actor: { kind: "human", id: "local-cli" },
            session: { id: "legacy-chat" },
            project: { id: f.root, root: f.root },
            device: { id: f.device },
          },
        });
        expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
      }
    } finally {
      await assembly.close();
    }
    expect(existsSync(join(f.device, "device-id"))).toBe(false);
    for (const id of ids) {
      expect(f.cli("show", { id }).result!.lease!.holder.session).toEqual({
        id: "legacy-chat",
      });
      expect(
        f.cli("renew", { id }, { FORGE_SESSION: "foreign-chat" }, false).error
          ?.code,
      ).toBe("LEASE_NOT_HELD");
    }
    const owner = { FORGE_SESSION: "  legacy-chat  " };
    f.cli("renew", { id: ids[0] }, owner);
    f.close(ids[1]!, owner);
    f.cli("release", { id: ids[2] }, owner);
    expect(f.cli("show", { id: ids[1] }).result!.status).toBe("closed");
    expect(existsSync(join(f.device, "device-id"))).toBe(false);
  } finally {
    f.cleanup();
  }
}, 120000);
