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
  "/src/assembly/git-scope.js",
  "/src/assembly/saved-git-scope.js",
  "/src/assembly/cloud-lane-coordinator.js",
  "/src/blocks/work/bound-lane.js",
  "/src/blocks/work/bound-lane-state.js",
  "/src/blocks/work/entry.cjs",
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

// The public catalog after removing receipt.admit/show: help, its full contract and the MCP
// tool listing must stay byte for byte the same until an intentional catalog change.
const catalog = {
  help: "d082b65bcc5bf39a55c831265b1a0fa8f6ad5d33cad2c8f828bc6ab441b6a03b",
  helpJson: "772ac3b20bf0ab24f3aa4ca578a2040ffe1cbf0ba891314859a2db0fb71aa02d",
  mcpTools: "77c0367db5028c168088b5576bb32dec4a4e0483266cd783fa124d17ab8423e2",
};

async function mcpTools(root: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(node, [bin, "--mcp"], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  const answer = new Promise<string>((done, fail) => {
    timer = setTimeout(
      () => fail(new Error(`MCP tools/list timed out: ${buffer}`)),
      20_000,
    );
    child.once("error", fail);
    // The server may exit before the requests are written.
    child.stdin.on("error", () => {});
    void exited.then(() =>
      fail(new Error(`MCP server exited before tools/list: ${buffer}`)),
    );
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      // The last piece may be half a line, so only whole lines count.
      const line = buffer
        .split("\n")
        .slice(0, -1)
        .find((text) => text.includes('"id":2'));
      if (line !== undefined) done(line);
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
  try {
    return await answer;
  } finally {
    clearTimeout(timer);
    child.kill();
    // Windows keeps the project folder locked until the server has exited.
    if (child.pid !== undefined) await exited;
  }
}

test("help, the help contract and the MCP tool listing are unchanged", async () => {
  const { root, env, cli } = project();
  try {
    const defaultListing = await mcpTools(root, env);
    expect(
      {
        help: sha(cli(["--help"])),
        helpJson: sha(cli(["--help", "--json"])),
        mcpTools: sha(defaultListing),
      },
      "Help or the MCP tool listing changed. If that is intended, replace the digests in `catalog` above with the Received values shown below.",
    ).toEqual(catalog);

    const listed = (json: string) =>
      (JSON.parse(json) as { result: { tools: { name: string }[] } }).result
        .tools;
    const defaults = listed(defaultListing);
    const expose = [
      ...defaults.map(({ name }) => name.replace("_", ".")),
      "lane.dispatch",
    ];
    writeFileSync(
      join(root, ".forge/config.yaml"),
      `${config}mcp:\n  expose: ${JSON.stringify(expose)}\n`,
    );
    const explicit = listed(await mcpTools(root, env));
    expect({
      added: explicit
        .filter(({ name }) => name === "lane_dispatch")
        .map(({ name }) => name),
      rest: explicit.filter(({ name }) => name !== "lane_dispatch"),
    }).toEqual({ added: ["lane_dispatch"], rest: defaults });
  } finally {
    removeQuietly(root);
  }
}, 60_000);

test.each([{}, { id: "work-7" }])(
  "unbound local lane.control reports unavailable for %j",
  (input) => {
    const { root, env } = project();
    try {
      const result = spawnSync(
        node,
        [bin, "lane", "control", "--input", JSON.stringify(input)],
        {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr + result.stdout).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        status: "FAIL",
        error: { code: "UNAVAILABLE" },
      });
    } finally {
      removeQuietly(root);
    }
  },
  30_000,
);
