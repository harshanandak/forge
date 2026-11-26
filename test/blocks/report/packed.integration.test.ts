import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { environmentWithoutBun } from "../../../tools/pack-smoke/environment.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import { packedConsumer } from "../../integration/packed-consumer.ts";
import { createReport, reportFixture, reportMessage } from "./fixtures.ts";

async function fileViaMcp(
  node: string,
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(node, [bin, "--mcp"], {
    cwd,
    env,
    windowsHide: true,
    timeout: 20_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  let sequence = 0;
  const send = (message: object) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  async function rpc(method: string, params: object) {
    const id = ++sequence;
    send({ id, method, params });
    for (;;) {
      const entry = await replies.next();
      if (entry.done) throw new Error(`Packed MCP closed during ${method}`);
      const reply = JSON.parse(entry.value) as {
        id?: number;
        error?: unknown;
        result: unknown;
      };
      if (reply.id !== id) continue;
      expect(reply.error).toBeUndefined();
      return reply.result;
    }
  }
  try {
    expect(
      await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "packed-report", version: "1" },
      }),
    ).toHaveProperty("serverInfo");
    send({ method: "notifications/initialized" });
    const listing = (await rpc("tools/list", {})) as {
      tools: { name: string }[];
    };
    expect(
      listing.tools.find(({ name }) => name === "report_create"),
    ).toMatchObject({
      annotations: {
        openWorldHint: false,
        readOnlyHint: false,
        idempotentHint: false,
      },
      inputSchema: { additionalProperties: false },
    });
    const result = (await rpc("tools/call", {
      name: "report_create",
      arguments: { message: reportMessage },
    })) as { structuredContent: unknown; content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text)).toEqual(
      result.structuredContent,
    );
    return result.structuredContent;
  } finally {
    child.stdin.end();
    lines.close();
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
}

function packedReportFixture() {
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  const f = reportFixture();
  const env = environmentWithoutBun(node, {
    ...process.env,
    FORGE_DEVICE_ROOT: f.device,
    HOME: f.home,
    USERPROFILE: f.home,
  });
  const installed = join(packedConsumer(), "node_modules", "forge-workflow");
  return {
    ...f,
    node,
    env,
    installed,
    cli(args: string[], bin = join(installed, "dist/bin/forge.js")) {
      const reply = spawnSync(node, [bin, ...args], {
        env,
        cwd: f.root,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      if (reply.error) throw reply.error;
      return { ...reply, envelope: JSON.parse(reply.stdout) as ResultEnvelope };
    },
  };
}

test("installed Node CLI and stdio MCP file into one private device record", async () => {
  using f = packedReportFixture();
  f.configure({ blocks: {}, mcp: { expose: ["report.create"] } });
  expect(
    spawnSync("bun", ["--version"], { env: f.env, windowsHide: true }).error,
  ).toBeDefined();
  const first = f.cli(createReport);
  expect(first.status, first.stdout + first.stderr).toBe(0);
  expect(first.envelope).toMatchObject({
    ok: true,
    status: "OK",
    result: { count: 1, promotion: "unpromoted" },
  });
  const fingerprint = (first.envelope.result as { fingerprint: string })
    .fingerprint;
  expect(
    await fileViaMcp(
      f.node,
      join(f.installed, "dist/bin/forge.js"),
      f.root,
      f.env,
    ),
  ).toMatchObject({
    ok: true,
    op: "report.create",
    status: "OK",
    result: { fingerprint, count: 2, promotion: "unpromoted" },
  });
  const { rows, events } = await f.read();
  expect(rows).toMatchObject([
    {
      key: fingerprint,
      value: {
        count: 2,
        summary: reportMessage,
        context: { harness: "mcp", os: process.platform },
      },
    },
  ]);
  expect(events).toHaveLength(2);
}, 30_000);

test("a missing inlined report entry returns a safe error from a private package copy", () => {
  using f = packedReportFixture();
  const copy = join(
    packedConsumer(),
    `private-report-install-${crypto.randomUUID()}`,
  );
  mkdirSync(copy);
  try {
    cpSync(f.installed, copy, { recursive: true });
    const entry = join(copy, "dist/src/blocks/report/entry.cjs");
    expect(existsSync(entry)).toBe(true);
    unlinkSync(entry);
    const bin = join(copy, "dist/bin/forge.js");
    for (const config of [
      undefined,
      '{"blocks":{"memory":{},"report":{"source":{"builtin":"forge/report"}}}}',
    ]) {
      if (config) f.configure(config);
      const refused = f.cli(createReport, bin);
      expect(refused.status).toBe(1);
      expect(refused.envelope).toMatchObject({
        ok: false,
        error: { code: "PROVIDER_MISSING" },
      });
      expect(refused.stdout).toContain("Repair or reinstall Forge");
      expect(
        JSON.stringify([
          refused.envelope,
          refused.stdout,
          refused.stderr,
        ]).includes("private-report-install"),
      ).toBe(false);
      expect(existsSync(f.records)).toBe(false);
    }
    expect(f.cli(["memory", "search", "probe"], bin).status).toBe(0);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 30_000);
