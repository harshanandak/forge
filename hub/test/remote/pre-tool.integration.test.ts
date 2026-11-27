import { expect } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MCP_TOOL_NAMES } from "../../src/contract/mcp.ts";
import { digest, key, safeOutput } from "./fixtures.ts";
import {
  answer,
  child,
  deny,
  failure,
  guard,
  hookTest,
  hubRoot,
  hung,
  mode,
  r1,
  r2,
  r3,
  silence,
} from "./hook-fixtures.ts";

const timeout = 30_000;
const check = hookTest(timeout);
const forge = (tool: string) => "mcp__forge-hub__" + tool;
const owns = { sessionId: "ses_a" };
const foreignId = { sessionId: "ses_b" };
const foreignTools = ["inbox", "wait", "send"];
const modes = ["normal", "reply_only"];

check(
  "P1-P3 every Forge call uses its own registered id and a fresh lookup",
  async (f) => {
    const original = await f.files();
    expect(await f.tool(forge("hello"))).toEqual(deny(r2));
    for (const current of modes) {
      f.respond = () => mode(current);
      for (const tool of foreignTools)
        expect(await f.tool(forge(tool), foreignId)).toEqual(deny(r2));
      for (const tool of MCP_TOOL_NAMES)
        expect(await f.tool(forge(tool), owns)).toEqual(silence);
    }
    expect(await f.files()).toEqual(original);
    expect(f.seen).toHaveLength(
      1 + modes.length * (foreignTools.length + MCP_TOOL_NAMES.length),
    );
    expect(f.seen.every(({ path }) => path === "/hook/mode")).toBe(true);
  },
);

const failures = [
  ["HUB_TIMEOUT", hung],
  ["UNAUTHENTICATED", () => failure(401, "UNAUTHENTICATED")],
  ["BLOCK_DISABLED", () => failure(503, "BLOCK_DISABLED")],
  ["INVALID_RESPONSE", () => Response.json([])],
  ["UNREGISTERED", () => mode("unregistered")],
] as const;
const probed = [forge("inbox"), "Write"];
for (const [code, respond] of failures) {
  check("P4 lookup failure denies both tools: " + code, async (f) => {
    f.respond = (_path, signal) => respond(signal);
    for (const tool of probed) {
      const time = performance.now();
      expect(await f.tool(tool, owns)).toEqual(deny(r3(code)));
      expect(performance.now() - time).toBeLessThan(3500);
    }
    expect(f.seen).toHaveLength(2);
  });
}

check(
  "P4 missing or malformed key and closed port all fail closed",
  async (f) => {
    await writeFile(f.keyPath, "bad");
    const unavailable = deny(r3("HOST_KEY_UNAVAILABLE"));
    for (const file of [f.path("missing"), f.keyPath]) {
      const env = { FORGE_HUB_HOST_KEY_FILE: file };
      for (const tool of probed)
        expect(await f.tool(tool, {}, env)).toEqual(unavailable);
    }
    expect(f.seen).toEqual([]);
    await writeFile(f.keyPath, key);
    await f.stopServer();
    for (const tool of probed)
      expect(await f.tool(tool)).toEqual(deny(r3("HUB_UNREACHABLE")));
  },
);

check(
  "P5 foreign read then outage denies writes while a local Read works",
  async (f) => {
    await writeFile(f.path("file"), "fixture");
    const original = await f.files();
    expect(await f.tool()).toEqual(silence);
    expect(await f.files()).toEqual(original);
    f.respond = () => mode("reply_only");
    expect(await f.tool(forge("inbox"), owns)).toEqual(silence);
    await f.stopServer();
    expect(await f.tool()).toEqual(deny(r3("HUB_UNREACHABLE")));
    expect(await f.tool("Read", { file_path: "file" })).toEqual(silence);
    expect(f.seen).toHaveLength(2);
  },
);

check(
  "P6-P8 lookalikes, writes, tasks, web and Bash use fresh mode",
  async (f) => {
    const lookalikes = [
      "mcp__forge-hub-evil__inbox",
      "mcp__forge-hub__x__reply",
      "mcp__other__hello",
      forge("merge"),
    ];
    const other = [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Task",
      "WebFetch",
      "WebSearch",
    ];
    const commands = [
      "git status",
      "ls -la",
      "git diff --output=changed.txt",
      "rg --pre ./x foo",
      "printf a\nprintf b",
      "rm -rf build",
    ];
    const original = await f.files();
    f.respond = () => mode("reply_only");
    for (const tool of [...lookalikes, ...other])
      expect(await f.tool(tool)).toEqual(deny(r1));
    for (const command of commands)
      expect(await f.tool("Bash", { command })).toEqual(deny(r1));
    f.respond = () => mode();
    for (const tool of [...lookalikes, "Write", "Task", "Bash"]) {
      expect(await f.tool(tool, { command: "git status" })).toEqual(silence);
    }
    expect(await f.files()).toEqual(original);
    expect(f.seen).toHaveLength(
      2 * lookalikes.length + other.length + commands.length + 3,
    );
  },
);

check("P9 inside cwd, Read Glob and Grep do not need network", async (f) => {
  await mkdir(f.path("src"));
  const file = join(f.root, "src", "file.ts");
  await writeFile(file, "fixture");
  f.respond = () => mode("reply_only");
  for (const offline of [false, true]) {
    if (offline) await f.stopServer();
    expect(await f.tool("Read", { file_path: file })).toEqual(silence);
    expect(await f.tool("Glob", { pattern: "**/*.ts" })).toEqual(silence);
    expect(await f.tool("Grep", { path: "src", pattern: "/api/../" })).toEqual(
      silence,
    );
  }
  expect(f.seen).toEqual([]);
});

check("P10 outside and missing reads need clean mode", async (f) => {
  const cwd = f.path("cwd");
  const outside = f.path("outside");
  const file = join(outside, "file");
  await Promise.all([mkdir(cwd), mkdir(outside)]);
  await writeFile(file, "fixture");
  await symlink(outside, join(cwd, "link"), "junction");
  const cases = [
    ["Read", { file_path: file }],
    ["Glob", { pattern: "../x/*" }],
    ["Glob", { pattern: file }],
    ["Grep", { path: "..", pattern: "fixture" }],
    ["Grep", { path: ".", pattern: "fixture", glob: "../*" }],
    ["Read", { file_path: join(cwd, "link", "file") }],
    ["Read", { file_path: "missing" }],
  ] as const;
  for (const current of modes) {
    f.respond = () => mode(current);
    for (const [name, input] of cases)
      expect(await f.run("pre-tool", guard(cwd, name, input))).toEqual(
        current === "normal" ? silence : deny(r1),
      );
  }
  expect(f.seen).toHaveLength(modes.length * cases.length);
});

check("P10 UNC and device reads reach mode without realpath", async (f) => {
  const source = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    fs.realpath = () => process.exit(79);
    syncBuiltinESMExports();
  `;
  const flags = ["--import", `data:text/javascript;base64,${btoa(source)}`];
  const run = (cwd: string, file_path: string) =>
    f.run("pre-tool", guard(cwd, "Read", { file_path }), {}, flags);
  expect((await run(f.root, "local")).status).toBe(79);
  f.respond = () => mode("reply_only");
  const unc = String.raw`\\example.invalid\share`;
  const device = String.raw`\\?\UNC\example.invalid\share`;
  for (const target of [unc, device, "//example.invalid/share"])
    expect(await run(f.root, target)).toEqual(deny(r1));
  expect(await run(unc, "file")).toEqual(deny(r1));
  expect(f.seen).toHaveLength(4);
});

check("P11 and Y1 invalid guard input refuses without a request", async (f) => {
  const base = guard(f.root);
  for (const input of [
    "not json",
    "null",
    "[]",
    '"x"',
    {},
    { ...base, tool_name: undefined },
    { ...base, session_id: 1 },
    guard(f.root, "Read", "bad"),
    { ...base, cwd: 1 },
  ])
    expect(await f.run("pre-tool", input)).toEqual(deny(r3("INVALID_INPUT")));
  expect(f.seen).toEqual([]);
});

check("P12 unset and non-loopback HTTP hub URL fail closed", async (f) => {
  for (const url of ["http://example.invalid", ""])
    expect(await f.tool("Write", {}, { FORGE_HUB_URL: url })).toEqual(
      deny(r3("HUB_URL_INVALID")),
    );
  expect(f.seen).toEqual([]);
});

check("P13 redirect does not send the host key to another port", async (f) => {
  let forwarded = 0;
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      forwarded++;
      return new Response();
    },
  });
  try {
    f.respond = () => Response.redirect(other.url, 307);
    const result = await f.tool();
    expect(result.status).toBe(2);
    expect(result.stderr).toStartWith(
      "Forge hub could not confirm this session",
    );
    expect(f.seen).toHaveLength(1);
    expect(forwarded).toBe(0);
  } finally {
    await other.stop(true);
  }
});

check(
  "P14-P15 correct base path, named tool, host session and fresh key",
  async (f) => {
    const env = {
      FORGE_HUB_URL: f.url + "/forge-hub",
      FORGE_HUB_MCP_SERVER: "other-hub",
    };
    const tool = "mcp__other-hub__inbox";
    f.respond = () => mode("reply_only");
    expect(await f.tool(tool, foreignId, env)).toEqual(deny(r2));
    const fresh = key.slice(0, -1) + "z";
    await writeFile(f.keyPath, fresh);
    const accepted = await f.tool(tool, owns, env);
    const rejected = await f.tool(forge("inbox"), owns, env);
    expect(accepted).toEqual(silence);
    expect(rejected).toEqual(deny(r1));
    safeOutput(JSON.stringify([accepted, rejected]), [fresh, digest(fresh)]);
    const expected = (bearer: string) => ({
      path: "/forge-hub/hook/mode",
      method: "POST",
      bearer: "Bearer " + bearer,
      type: "application/json",
      body: { host: "claude", hostSessionId: "s1" },
    });
    expect(f.seen).toEqual([key, fresh, fresh].map(expected));
  },
);

check(
  "X1 launcher checks mode once and Y1 bad hub replies fail closed",
  async (f) => {
    f.respond = () => mode("reply_only");
    expect(await f.tool()).toEqual(deny(r1));
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]?.bearer).toBe("Bearer " + key);
    for (const value of [
      null,
      { mode: 1 },
      { mode: "rogue" },
      { mode: "normal", sessionId: 123 },
    ]) {
      f.respond = () => answer(value);
      expect(await f.tool()).toEqual(deny(r3("INVALID_RESPONSE")));
    }
  },
);

check("Y3 importing built shared library has no launch effect", async (f) => {
  const sharedModule = new URL("../../dist/hooks/shared.js", import.meta.url);
  expect(
    await child(f.root, ["--import", sharedModule.href, "-e", ""]),
  ).toEqual(silence);
  expect(f.seen).toEqual([]);
  expect(hubRoot.length).toBeGreaterThan(0);
});
