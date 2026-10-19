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
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
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
export function localValues(clone, key) {
  const result = command(
    "git",
    ["-C", clone.root, "config", "--local", "--null", "--get-all", key],
    clone.root,
    clone.env,
  );
  assert.ok(
    result.status === 0 || result.status === 1,
    "read local configuration values",
  );
  return result.status === 1 ? [] : result.stdout.split("\0").slice(0, -1);
}
export function identitySnapshot(clone) {
  const snapshot = Object.fromEntries(
    [
      "user.name",
      "user.email",
      "credential.https://github.com.helper",
      "core.hooksPath",
      "forge.githubAccount",
    ].map((key) => [key, localValues(clone, key)]),
  );
  snapshot.effectiveHelpers = good(
    command(
      "git",
      [
        "-C",
        clone.root,
        "config",
        "--includes",
        "--null",
        "--get-all",
        "credential.https://github.com.helper",
      ],
      clone.root,
      clone.env,
    ),
    "read effective helper order through includes",
  )
    .split("\0")
    .slice(0, -1);
  return snapshot;
}
function fixtureEnvironment(parent, root, login, mode) {
  const home = join(parent, "home");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^GIT_/i.test(key) &&
        !/^(?:GH|GITHUB)_(?:TOKEN|HOST|REPO|CONFIG_DIR)$/i.test(key),
    ),
  );
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "xdg"),
    GH_CONFIG_DIR: join(home, "gh"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "globalconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    FAKE_GH_MODE: mode,
    FAKE_GH_LOG: join(root, ".git/fake-gh.jsonl"),
    FORGE_DEVICE_ROOT: join(root, ".git/fixture-device"),
    GH_TOKEN: credentialFor(
      login === "alpha-user" ? "beta-user" : "alpha-user",
    ),
  };
}
export function environmentLauncher(shellProgram) {
  const candidates =
    process.platform === "win32"
      ? [
          join(dirname(shellProgram), "env.exe"),
          join(dirname(shellProgram), "../usr/bin/env.exe"),
        ]
      : ["/usr/bin/env", "/bin/env"];
  const resolved = candidates.find(existsSync);
  assert.ok(
    resolved,
    "a trusted POSIX environment launcher is required for the shell fixture",
  );
  return resolved;
}
export function plantedEnvironment(clone) {
  const directory = join(clone.root, ".git/planted-programs");
  mkdirSync(directory, { recursive: true });
  const marker = join(directory, "env-called");
  const startupMarker = join(directory, "startup-called");
  const startupFile = join(directory, "startup");
  rmSync(marker, { force: true });
  rmSync(startupMarker, { force: true });
  const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;
  writeFileSync(
    join(directory, "env"),
    `#!/bin/sh\nprintf 'called' > ${quote(marker)}\nexec ${quote(clone.config.envProgram)} "$@"\n`,
    { mode: 0o700 },
  );
  writeFileSync(startupFile, `printf 'called' > ${quote(startupMarker)}\n`, {
    mode: 0o600,
  });
  const key =
    Object.keys(clone.env).find((name) => name.toLowerCase() === "path") ??
    "PATH";
  const env = {
    ...clone.env,
    [key]: `${directory}${delimiter}${clone.env[key] ?? ""}`,
  };
  return {
    marker,
    startupMarker,
    env,
    startupEnv: { ...env, BASH_ENV: startupFile, ENV: startupFile },
  };
}
async function authorise(call, root) {
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
    const entryHash = createHash("sha256")
      .update(readFileSync(join(root, "fixture-block/entry.cjs")))
      .digest("hex");
    const target =
      process.env.FORGE_MUTATION_TARGET ??
      join(installed, "dist/src/blocks/github-accounts/entry.cjs");
    const hash = createHash("sha256")
      .update(readFileSync(target))
      .digest("hex");
    assert.equal(
      hash,
      process.env.FORGE_MUTATION_HASH,
      "capture must use the private mutated bytes",
    );
    appendFileSync(
      process.env.FORGE_ACCOUNTS_CAPTURE_PROOF,
      JSON.stringify({ hash, entryHash, digest: checked.digest }) + "\n",
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
}
export async function reuseFixture(descriptor, mode = "ready") {
  const { root, login, baseline } = descriptor;
  const env = fixtureEnvironment(dirname(root), root, login, mode);
  const deviceRoot = env.FORGE_DEVICE_ROOT;
  const assembly = await createAssembly({
    root,
    deviceRoot,
    providers: { env },
  });
  const context = {
    actor: { kind: "human", id: "packed-fixture" },
    session: { id: `${basename(root)}-mutation` },
    device: { id: deviceRoot },
    project: { id: root, root },
  };
  let sequence = 0;
  const call = (verb, input = {}) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `mutant-${++sequence}`,
      op: verb.includes(".") ? verb : `github-account.${verb}`,
      input,
      caller: "human",
      context,
    });
  try {
    const shown = ok(await call("config.show"), "read prepared composition");
    const config = shown.effective.blocks["github-accounts"].config;
    await authorise(call, root);
    assert.deepEqual(
      assembly.catalog.unavailable(),
      [],
      "prepared block providers must bind",
    );
    return {
      root,
      env,
      login,
      baseline,
      account: accounts[login],
      config,
      call,
      close: () => assembly.close(),
    };
  } catch (error) {
    await assembly.close();
    throw error;
  }
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
  let env = fixtureEnvironment(parent, root, login, mode);
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
  // Seed fixture-owned native configuration once; real Git reads it back in the
  // identity/restoration assertions. This removes seven setup subprocesses per clone.
  const configPath = join(root, ".git/config");
  writeFileSync(
    join(root, ".git/native-helpers.config"),
    '[credential "https://github.com"]\n\thelper = fixture-included-helper\n',
  );
  writeFileSync(
    join(root, ".git/conditional-helpers.config"),
    '[credential "https://github.com"]\n\thelper = fixture-conditional-helper\n',
  );
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8") +
      '\n[user]\n\tname = Native First\n\tname = Native Last\n\temail = native-first@example.invalid\n\temail = native-last@example.invalid\n[credential "https://github.com"]\n\thelper = ""\n\thelper = fixture-native-helper\n' +
      (nativeHooks ? "[core]\n\thooksPath = .git/native-hooks\n" : "") +
      '[include]\n\tpath = native-helpers.config\n[includeIf "onbranch:*"]\n\tpath = conditional-helpers.config\n[credential "https://github.com"]\n\tuseHttpPath = true\n',
  );
  mkdirSync(join(root, ".git/native-hooks"));
  const deviceRoot = join(root, ".git/fixture-device");
  env.FORGE_DEVICE_ROOT = deviceRoot;
  const shellProgram = shell(root, env);
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
    shellProgram,
    envProgram: environmentLauncher(shellProgram),
  };
  let assembly = await createAssembly({
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
  try {
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
    await authorise(call, root);
    assert.deepEqual(
      assembly.catalog.unavailable(),
      [],
      "account block must have every provider bound",
    );
    return {
      root,
      get env() {
        return env;
      },
      login,
      account,
      config,
      get assembly() {
        return assembly;
      },
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
      async bind(options = {}) {
        return ok(
          await call("bind", {
            login,
            auto: true,
            repository: "fixture/project",
            ...options,
          }),
          `bind ${login}`,
        );
      },
      async reopen(nextMode) {
        await assembly.close();
        env = fixtureEnvironment(parent, root, login, nextMode);
        assembly = await createAssembly({
          root,
          deviceRoot,
          providers: { env },
        });
      },
      async configure(values) {
        const shown = ok(
          await call("config.show"),
          "read configuration revision",
        );
        ok(
          await call("config.apply", {
            expectRevision: shown.revision,
            patch: Object.entries(values).map(([key, value]) => ({
              op: "set",
              path: `/blocks/github-accounts/config/${key}`,
              value,
            })),
          }),
          "configure fixture capability",
        );
        Object.assign(config, values);
      },
      async close() {
        await assembly.close();
      },
    };
  } catch (error) {
    const [closed] = await Promise.allSettled([assembly.close()]);
    if (closed.status === "rejected")
      throw new AggregateError(
        [error, closed.reason],
        "fixture setup and cleanup failed",
        { cause: error },
      );
    throw error;
  }
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
