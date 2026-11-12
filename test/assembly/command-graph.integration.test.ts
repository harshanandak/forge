import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeQuietly } from "../spawn-budget.ts";

// One project with the three blocks the Speed job enables, run through the built package.
const found = Bun.which("node");
if (!found) throw new Error("Node runtime required");
const node: string = found;
const bin = resolve("dist/bin/forge.js");
const config = [
  "schemaVersion: forge.config/1",
  "blocks:",
  ...["work", "memory", "check"].flatMap((name) => [
    `  ${name}:`,
    "    source:",
    `      builtin: forge/${name}`,
  ]),
  "    config:",
  "      commands:",
  "        probe: node --version",
  "",
].join("\n");

function project() {
  const root = mkdtempSync(join(tmpdir(), "forge-command-graph-"));
  mkdirSync(join(root, ".forge"));
  writeFileSync(join(root, ".forge/config.yaml"), config);
  writeFileSync(join(root, "gitconfig"), "");
  const env = {
    ...process.env,
    FORGE_DEVICE_ROOT: join(root, "device"),
    FORGE_DEVICE_ID: "graph",
    FORGE_SESSION: "graph",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
  };
  const cli = (args: string[], preload: string[] = []) => {
    const result = spawnSync(node, [...preload, bin, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    return result.stdout;
  };
  return { root, env, cli };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// Modules `issue show` never calls. Loading them is memory spent on nothing, so each
// is imported only by the operation that uses it.
const unrelated = [
  "/src/adapters/http/index.js",
  "/src/adapters/http/command-refusal.js",
  "/src/assembly/cloud-login.js",
  "/src/assembly/cloud-state-client.js",
  "/src/assembly/skills.js",
  "/src/surface/skills.js",
  "node:https",
];

test("issue show loads none of the modules it never calls", () => {
  const { root, cli } = project();
  try {
    const created = JSON.parse(
      cli(["issue", "create", "--input", '{"title":"graph"}']),
    ) as { result: { id: string } };
    const trace = join(root, "modules.json");
    const hook = `import { registerHooks } from 'node:module';
      import { writeFileSync } from 'node:fs';
      const loaded = [];
      registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
      process.once('exit', () => writeFileSync(${JSON.stringify(trace)}, JSON.stringify(loaded)));`;
    const shown = JSON.parse(
      cli(
        ["issue", "show", created.result.id],
        ["--import", `data:text/javascript,${encodeURIComponent(hook)}`],
      ),
    ) as { ok: boolean };
    expect(shown.ok).toBe(true);
    const loaded = JSON.parse(readFileSync(trace, "utf8")) as string[];
    expect(loaded.some((url) => url.includes("/src/assembly/index.js"))).toBe(
      true,
    );
    const stray = loaded.filter((url) =>
      unrelated.some((name) => url.includes(name)),
    );
    expect(stray, "modules loaded by issue show but never called").toEqual([]);
  } finally {
    removeQuietly(root);
  }
}, 60_000);

// The output of main before the lazy command graph, as digests: help, the full help
// contract and the MCP tool listing must stay byte for byte the same.
const catalog = {
  help: "3bd22f481e711b265c08a3f23dc69d7ea3a038e5aca8606ee5bd1c1ed9f3a8bd",
  helpJson: "fc90d2eba3aaa60acacb152e23e0cd34ca196e9fd691903fc52cd1e7553db8d2",
  mcpTools: "20940d83078f63696241e5f9c58074e05e833047865f72b33787bb9ba3c7a19a",
};

function mcpTools(root: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(node, [bin, "--mcp"], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`MCP tools/list timed out: ${buffer}`));
    }, 20_000);
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      // The last piece may be half a line, so only whole lines count.
      const line = buffer
        .split("\n")
        .slice(0, -1)
        .find((text) => text.includes('"id":2'));
      if (line === undefined) return;
      clearTimeout(timer);
      // Windows keeps the project folder locked until the server has exited.
      child.once("close", () => done(line));
      child.kill();
    });
    for (const message of [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "graph", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ])
      child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

test("help, the help contract and the MCP tool listing are unchanged", async () => {
  const { root, env, cli } = project();
  try {
    expect(
      {
        help: sha(cli(["--help"])),
        helpJson: sha(cli(["--help", "--json"])),
        mcpTools: sha(await mcpTools(root, env)),
      },
      "Help or the MCP tool listing changed. If that is intended, replace the digests in `catalog` above with the Received values shown below.",
    ).toEqual(catalog);
  } finally {
    removeQuietly(root);
  }
}, 60_000);
