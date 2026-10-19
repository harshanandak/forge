import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly } from "forge-workflow/runtime";

export const installed = dirname(
  fileURLToPath(import.meta.resolve("forge-workflow/package.json")),
);
export const bin = join(installed, "dist/bin/forge.js");
export const fixture = dirname(fileURLToPath(import.meta.url));
export const accounts = {
  "alpha-user": {
    id: 201,
    name: "Alpha Fixture",
    email: "201+alpha-user@users.noreply.github.com",
  },
  "beta-user": {
    id: 202,
    name: "Beta Fixture",
    email: "202+beta-user@users.noreply.github.com",
  },
};
export const credentialFor = (login) =>
  Buffer.from(`fake-credential:${login}`).toString("base64url");
export function command(program, args, cwd, env, input) {
  return spawnSync(program, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
  });
}
export async function parallelCommand(program, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      windowsHide: true,
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}
export function good(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stdout} ${result.stderr}`);
  return result.stdout;
}
export function git(root, env, ...args) {
  return good(
    command("git", ["-C", root, ...args], root, env),
    `git ${args.slice(0, 2).join(" ")}`,
  ).trim();
}
export function ok(result, label) {
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
  return result.result;
}
export function shell(root, env) {
  if (process.platform !== "win32") return "/bin/sh";
  const gitExec = git(root, env, "--exec-path");
  const base = dirname(dirname(dirname(gitExec)));
  const result = [
    join(base, "usr/bin/sh.exe"),
    join(base, "bin/bash.exe"),
  ].find(existsSync);
  assert.ok(
    result,
    "Git Bash shell is required for managed router/hook acceptance on Windows",
  );
  return result;
}
export function hashTree(root, exclude = new Set()) {
  if (!existsSync(root)) return null;
  const files = {};
  function walk(directory, relative = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (exclude.has(path)) continue;
      if (entry.isDirectory()) walk(join(directory, entry.name), path);
      else
        files[path] = createHash("sha256")
          .update(readFileSync(join(directory, entry.name)))
          .digest("hex");
    }
  }
  walk(root);
  return files;
}
export function localState(clone) {
  return {
    config: createHash("sha256")
      .update(readFileSync(join(clone.root, ".git/config")))
      .digest("hex"),
    managed: hashTree(join(clone.root, ".git/.forge-github-accounts")),
  };
}
export async function cloneFixture(
  parent,
  name,
  login,
  policy = "refuse",
  mode = "ready",
  nativeHooks = true,
) {
  const root = join(parent, name);
  mkdirSync(root);
  const home = join(parent, "home");
  mkdirSync(home, { recursive: true });
  const global = join(home, "globalconfig");
  if (!existsSync(global))
    writeFileSync(
      global,
      "[user]\n\tname = Global Fixture\n\temail = global@example.invalid\n",
    );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^GIT_/i.test(key) &&
        !/^(?:GH|GITHUB)_(?:TOKEN|HOST|REPO|CONFIG_DIR)$/i.test(key),
    ),
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "xdg"),
    GH_CONFIG_DIR: join(home, "gh"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: global,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    FAKE_GH_MODE: mode,
    FAKE_GH_LOG: join(root, ".git/fake-gh.jsonl"),
    GH_TOKEN: credentialFor(
      login === "alpha-user" ? "beta-user" : "alpha-user",
    ),
  });
  git(root, env, "init", "--quiet");
  const account = accounts[login];
  git(
    root,
    env,
    "-c",
    `user.name=${account.name}`,
    "-c",
    `user.email=${account.email}`,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "baseline",
  );
  const baseline = git(root, env, "rev-parse", "HEAD");
  for (const [key, values] of Object.entries({
    "user.name": ["Native First", "Native Last"],
    "user.email": [
      "native-first@example.invalid",
      "native-last@example.invalid",
    ],
    "credential.https://github.com.helper": ["", "fixture-native-helper"],
    ...(nativeHooks ? { "core.hooksPath": [".git/native-hooks"] } : {}),
  }))
    for (const value of values)
      git(root, env, "config", "--local", "--add", key, value);
  mkdirSync(join(root, ".git/native-hooks"));
  const deviceRoot = join(root, ".git/fixture-device");
  env.FORGE_DEVICE_ROOT = deviceRoot;
  const config = {
    environmentNames: Object.keys(env).filter((name) =>
      /^(?:path|pathext|systemroot|windir|comspec|home|userprofile|xdg_config_home|gh_config_dir|tmp|temp|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|GIT_TERMINAL_PROMPT|GIT_OPTIONAL_LOCKS|FAKE_GH_MODE|FAKE_GH_LOG|GH_TOKEN|FORGE_DEVICE_ROOT)$/i.test(
        name,
      ),
    ),
    gitProgram: "git",
    ghProgram: process.execPath,
    ghArgs: [join(fixture, "fake-gh.mjs")],
    commandTimeoutMs: 10000,
    maxOutputBytes: 65536,
    maxFileBytes: 1048576,
    maxCommits: 100,
    coauthorPolicy: policy,
    aiCoauthorPatterns: ["codex", "claude", "copilot", "openai"],
    allowedGhCommands: ["repo view", "pr create", "pr list", "pr view"],
    identityName: "profile",
    identityEmail: "noreply",
    forgeCommand: [process.execPath, bin],
    shellProgram: shell(root, env),
  };
  const assembly = await createAssembly({
    root,
    deviceRoot,
    providers: { env },
  });
  const context = {
    actor: { kind: "human", id: "packed-fixture" },
    session: { id: `${name}-session` },
    device: { id: deviceRoot },
    project: { id: root, root },
  };
  let sequence = 0;
  const call = (verb, input = {}) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `${name}-${++sequence}`,
      op: verb.includes(".") ? verb : `github-account.${verb}`,
      input,
      caller: "human",
      context,
    });
  const shown = ok(await call("config.show"), "show initial composition");
  ok(
    await call("config.apply", {
      expectRevision: shown.revision,
      patch: [
        { op: "set", path: "/mcp", value: { expose: ["github-account"] } },
        {
          op: "set",
          path: "/blocks/github-accounts",
          value: { source: { builtin: "forge/github-accounts" }, config },
        },
      ],
    }),
    "configure account block",
  );
  cpSync(
    join(installed, "dist/src/blocks/github-accounts"),
    join(root, "fixture-block"),
    { recursive: true },
  );
  const checked = ok(
    await call("block.check", { path: "./fixture-block" }),
    "capture account block",
  );
  if (process.env.FORGE_MUTATION_HASH) {
    const hash = createHash("sha256")
      .update(readFileSync(join(root, "fixture-block/entry.cjs")))
      .digest("hex");
    assert.equal(
      hash,
      process.env.FORGE_MUTATION_HASH,
      "capture must use the private mutated entry bytes",
    );
    appendFileSync(
      process.env.FORGE_MUTATION_PROOF,
      JSON.stringify({ hash, digest: checked.digest }) + "\n",
    );
  }
  ok(
    await call("block.admit", { digest: checked.digest }),
    "admit account block",
  );
  const manifest = JSON.parse(
    readFileSync(join(root, "fixture-block/forge.block.json"), "utf8"),
  );
  const effects = [
    ...new Set(
      Object.values(manifest.operations).flatMap(
        (operation) => operation.effects,
      ),
    ),
  ];
  ok(
    await call("config.grant", { digest: checked.digest, effects }),
    "grant account block effects",
  );
  assert.deepEqual(
    assembly.catalog.unavailable(),
    [],
    "account block must have every provider bound",
  );
  return {
    root,
    env,
    login,
    account,
    config,
    assembly,
    call,
    baseline,
    cli(verb, input = {}, expected = 0) {
      const result = command(
        process.execPath,
        [bin, "github-account", verb, "--input", JSON.stringify(input)],
        root,
        env,
      );
      assert.equal(
        result.status,
        expected,
        `generated ${verb}: ${result.stdout} ${result.stderr}`,
      );
      return JSON.parse(result.stdout);
    },
    async bind() {
      return ok(
        await call("bind", {
          login,
          auto: true,
          repository: "fixture/project",
        }),
        `bind ${login}`,
      );
    },
    async close() {
      await assembly.close();
    },
  };
}
export async function mcp(clone, op, input = {}) {
  const child = spawn(process.execPath, [bin, "--mcp"], {
    cwd: clone.root,
    env: clone.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let id = 0,
    buffer = "",
    stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(
        () => reject(Error(`MCP request timeout: ${stderr}`)),
        60000,
      );
      pending.set(next, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n",
      );
    });
  try {
    await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "accounts-fixture", version: "1.0.0" },
    });
    child.stdin.write(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    );
    const response = await rpc("tools/call", {
      name: "catalog_call",
      arguments: { op: `github-account.${op}`, input },
    });
    assert.ok(response.result, `MCP account call: ${JSON.stringify(response)}`);
    return response.result.structuredContent;
  } finally {
    child.stdin.end();
    const deadline = setTimeout(() => child.kill(), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
    }
  }
}
