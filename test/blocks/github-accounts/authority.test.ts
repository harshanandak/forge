import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
async function refused(promise: Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code });
}

type Handler = (args: unknown) => Promise<unknown>;
function load(replace?: { from: string; to: string }): Record<string, Handler> {
  let source = readFileSync(
    new URL("../../../src/blocks/github-accounts/entry.cts", import.meta.url),
    "utf8",
  );
  if (replace) {
    expect(source.includes(replace.from)).toBe(true);
    source = source.replace(replace.from, replace.to);
  }
  const module = { exports: {} as Record<string, Handler> };
  runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source), {
    module,
    fail: (code: string, message: string) => {
      throw Object.assign(new Error(message), { code });
    },
  });
  return module.exports;
}
function harness(actualLogin = "alice") {
  const calls: {
    args: readonly string[];
    env: Readonly<Record<string, string>>;
  }[] = [];
  const writes: string[] = [];
  const config = {
    environmentNames: [
      "PATH",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GIT_DIR",
      "GIT_CONFIG_COUNT",
    ],
    ghProgram: "gh",
    gitProgram: "git",
    ghArgs: [],
    commandTimeoutMs: 1000,
    maxOutputBytes: 10000,
    maxFileBytes: 10000,
    maxCommits: 10,
    coauthorPolicy: "refuse",
    aiCoauthorPatterns: ["codex"],
    forgeCommand: ["forge"],
    shellProgram: "sh",
    envProgram: "env",
    identityName: "profile",
    identityEmail: "noreply",
    allowedGhCommands: ["pr create", "auth token", "api user"],
  };
  const services = {
    environment: {
      platform: "linux",
      select: () => ({
        PATH: "/bin",
        GH_TOKEN: "ambient-value",
        GITHUB_TOKEN: "ambient-value",
        GIT_DIR: "/wrong",
        GIT_CONFIG_COUNT: "9",
      }),
    },
    process: {
      cwd: "/clone",
      resolve: (path: string) => ({ kind: "resolved", path }),
      run: (
        _program: unknown,
        args: readonly string[],
        options: { env: Readonly<Record<string, string>> },
      ) => {
        calls.push({ args, env: options.env });
        const stdout =
          args[0] === "auth"
            ? "stored-fixture-credential"
            : args[0] === "api" && args[1] === "user"
              ? JSON.stringify({ login: actualLogin, id: 42, name: "Alice" })
              : args[0] === "api" && args[1] === "user/emails"
                ? JSON.stringify([
                    { email: "alice@example.com", verified: true },
                    { email: "other@example.com", verified: false },
                  ])
                : "";
        return Promise.resolve({
          stdout,
          stderr: "",
          exitCode: 0,
          timedOut: false,
          truncated: false,
          signal: null,
          durationMs: 0,
        });
      },
    },
    files: {
      read: () => undefined,
      write: (path: string) => writes.push(path),
      remove: () => {},
      roots: { common: "/clone/.git", git: "/clone/.git", project: "/clone" },
    },
    crypto: { randomUUID: () => "fixture" },
  };
  const typed = {
    resolve: services.process.resolve,
    run: services.process.run,
  };
  return {
    calls,
    writes,
    config,
    services: {
      ...services,
      process: {
        ...services.process,
        run: () => {
          throw new Error(
            "Generic process launch is forbidden for account/repository commands",
          );
        },
      },
      repository: typed,
      account: {
        ...typed,
        scripts: () => ({
          router: "fixture-router",
          credential: "fixture-credential",
        }),
      },
    },
  };
}
test("automatic binding refuses a missing configured shell before clone writes", async () => {
  const h = harness();
  const services = {
    ...h.services,
    process: {
      ...h.services.process,
      resolve: (program: string) =>
        program === "sh"
          ? {
              kind: "unavailable",
              reason: "missing fixture shell",
              remedy: "configure shell",
            }
          : { kind: "resolved", path: "/trusted/" + program },
    },
  };
  await refused(
    load()["github-account.bind"]!({
      input: { login: "alice", auto: true, repository: "owner/repository" },
      config: h.config,
      services,
    }),
    "ACCOUNT_SHELL_UNAVAILABLE",
  );
  expect(h.writes).toEqual([]);
}, 1000);
test("binding without automatic scripts never resolves shell launchers", async () => {
  const h = harness("mallory");
  const services = {
    ...h.services,
    process: {
      ...h.services.process,
      resolve: () => {
        throw new Error("Shell resolution was not requested");
      },
    },
  };
  await refused(
    load()["github-account.bind"]!({
      input: { login: "alice", auto: false },
      config: h.config,
      services,
    }),
    "ACCOUNT_MISMATCH",
  );
  expect(h.writes).toEqual([]);
}, 1000);
test("automatic binding refuses a missing environment launcher before writes", async () => {
  const h = harness();
  const services = {
    ...h.services,
    process: {
      ...h.services.process,
      resolve: (program: string) =>
        program === "env"
          ? { kind: "unavailable", reason: "missing", remedy: "configure env" }
          : { kind: "resolved", path: "/trusted/" + program },
    },
  };
  await refused(
    load()["github-account.bind"]!({
      input: { login: "alice", auto: true },
      config: h.config,
      services,
    }),
    "ACCOUNT_SHELL_UNAVAILABLE",
  );
  expect(h.writes).toEqual([]);
}, 1000);
test("bound metadata and adapter scripts receive absolute launcher pins", async () => {
  const h = harness(),
    files = new Map<string, string>([["config", "[core]\n bare = false\n"]]);
  const pins: string[] = [];
  let rendered: unknown;
  const resolve = (program: string) => ({
    kind: "resolved" as const,
    path: "/trusted/" + program,
  });
  const services = {
    ...h.services,
    process: {
      ...h.services.process,
      resolve: (program: string) => {
        pins.push(program);
        return resolve(program);
      },
    },
    repository: { ...h.services.repository, resolve },
    account: {
      ...h.services.account,
      resolve,
      scripts: (options: unknown) => {
        rendered = options;
        return { router: "fixture-router", credential: "fixture-credential" };
      },
    },
    files: {
      ...h.services.files,
      read: (path: string) => files.get(path),
      write: (path: string, text: string) => {
        files.set(path, text);
      },
      remove: (path: string) => {
        files.delete(path);
      },
      inspect: () => ({ regular: true, executable: true, size: 1 }),
      lock: () => ({ release: () => {} }),
    },
  };
  await load()["github-account.bind"]!({
    input: { login: "alice", auto: true, repository: "owner/repository" },
    config: h.config,
    services,
  });
  expect(pins).toEqual(["sh", "env"]);
  expect(rendered).toMatchObject({
    envPath: "/trusted/env",
    shellPath: "/trusted/sh",
    ghPath: "/trusted/gh",
    gitPath: "/trusted/git",
  });
  expect(
    JSON.parse(files.get(".forge-github-accounts/metadata.json")!) as unknown,
  ).toMatchObject({ launchers: { env: "/trusted/env", shell: "/trusted/sh" } });
  expect(
    JSON.parse(files.get(".forge-github-accounts/metadata.json")!) as unknown,
  ).toMatchObject({
    installed: {
      "credential.https://github.com.helper": [
        "",
        "!'/clone/.git/.forge-github-accounts/credential-helper'",
      ],
    },
  });
}, 1000);
test("enabling the guard refuses a missing configured shell before transaction writes", async () => {
  const h = harness();
  const services = {
    ...h.services,
    process: {
      ...h.services.process,
      resolve: () => ({
        kind: "unavailable",
        reason: "missing",
        remedy: "configure shell",
      }),
    },
  };
  await refused(
    load()["github-account.hook"]!({
      input: { enabled: true },
      config: h.config,
      services,
    }),
    "ACCOUNT_SHELL_UNAVAILABLE",
  );
  expect(h.writes).toEqual([]);
}, 1000);
test("stored credential login is verified before clone mutation", async () => {
  const h = harness("mallory");
  await refused(
    load()["github-account.bind"]!({
      input: { login: "alice", auto: false },
      config: h.config,
      services: h.services,
    }),
    "ACCOUNT_MISMATCH",
  );
  expect(h.writes).toEqual([]);
  expect(h.calls).toHaveLength(2);
}, 1000);
test("ambient credentials and all Git location/config overrides are scrubbed", async () => {
  const h = harness("mallory");
  await refused(
    load()["github-account.bind"]!({
      input: { login: "alice", auto: false },
      config: h.config,
      services: h.services,
    }),
    "ACCOUNT_MISMATCH",
  );
  expect(h.calls[0]!.env.GH_TOKEN).toBeUndefined();
  expect(h.calls[0]!.env.GITHUB_TOKEN).toBeUndefined();
  expect(h.calls[0]!.env.GIT_DIR).toBeUndefined();
  expect(h.calls[0]!.env.GIT_CONFIG_COUNT).toBeUndefined();
  expect(h.calls[1]!.env.GH_TOKEN).toBe("stored-fixture-credential");
}, 1000);
test("unverified chosen commit emails fail before writes", async () => {
  const h = harness();
  await refused(
    load()["github-account.bind"]!({
      input: { login: "alice", email: "other@example.com", auto: false },
      config: h.config,
      services: h.services,
    }),
    "ACCOUNT_EMAIL_UNVERIFIED",
  );
  expect(h.writes).toEqual([]);
}, 1000);
test("configuration cannot authorize public credential extraction or identity overrides", async () => {
  const h = harness(),
    entry = load();
  for (const args of [
    ["auth", "token"],
    ["api", "user", "-HAuthorization: override"],
    ["pr", "create", "-Rother/repo"],
  ])
    await refused(
      entry["github-account.run"]!({
        input: { args },
        config: h.config,
        services: h.services,
      }),
      "ACCOUNT_COMMAND_REFUSED",
    );
  expect(h.calls).toEqual([]);
}, 1000);
test("removing the credential scrub restores the motivating ambient override", async () => {
  const h = harness("mallory");
  const entry = load({
    from: "delete env[key];",
    to: "void env[key];",
  });
  await refused(
    entry["github-account.bind"]!({
      input: { login: "alice", auto: false },
      config: h.config,
      services: h.services,
    }),
    "ACCOUNT_MISMATCH",
  );
  expect(h.calls[0]!.env.GH_TOKEN).toBe("ambient-value");
}, 1000);
test("transaction uses its owned lease and releases it on return and refusal", async () => {
  const h = harness();
  const locks: string[][] = [];
  let released = 0;
  const services = {
    ...h.services,
    files: {
      ...h.services.files,
      lock: (paths: readonly string[]) => {
        locks.push([...paths]);
        return {
          release: () => {
            released++;
          },
        };
      },
    },
  };
  expect(
    await load()["github-account.unbind"]!({
      input: {},
      config: h.config,
      services,
    }),
  ).toEqual({ unbound: true });
  expect(locks).toEqual([[".forge-github-accounts/transaction.lock"]]);
  expect(released).toBe(1);
  expect(h.writes).toEqual([]);
  const broken = {
    ...services,
    files: { ...services.files, read: () => "not-json" },
  };
  await refused(
    load()["github-account.unbind"]!({
      input: {},
      config: h.config,
      services: broken,
    }),
    "ACCOUNT_DATA_INVALID",
  );
  expect(released).toBe(2);
}, 1000);
test("repository and account commands cannot fall back to generic process dispatch", async () => {
  const source = readFileSync(
    new URL("../../../src/blocks/github-accounts/entry.cts", import.meta.url),
    "utf8",
  );
  type Command = (
    services: unknown,
    config: unknown,
    env: unknown,
    tool: "repository" | "account",
    program: string,
    args: readonly string[],
  ) => Promise<unknown>;
  const loadCommand = (withoutTypedPorts: boolean): Command => {
    const marker = "const port = s[tool];";
    expect(source.includes(marker)).toBe(true);
    const module = { exports: {} as { command: Command } };
    runInNewContext(
      new Bun.Transpiler({ loader: "ts" }).transformSync(
        (withoutTypedPorts
          ? source.replace(marker, "const port = s.process;")
          : source) + "\nmodule.exports = {command};",
      ),
      {
        module,
        fail: (code: string) => {
          throw Object.assign(new Error(code), { code });
        },
      },
    );
    return module.exports.command;
  };
  const calls = { repository: 0, account: 0, generic: 0 };
  const resolve = (program: string) => ({
    kind: "resolved",
    path: "/trusted/" + program,
  });
  const result = {
    stdout: "observed",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    truncated: false,
    signal: null,
    durationMs: 0,
  };
  const services = {
    files: { root: "/clone" },
    process: {
      resolve,
      run: () => {
        calls.generic++;
        throw new Error("generic dispatch forbidden");
      },
    },
    repository: {
      resolve,
      run: () => {
        calls.repository++;
        return Promise.resolve(result);
      },
    },
    account: {
      resolve,
      run: () => {
        calls.account++;
        return Promise.resolve(result);
      },
    },
  };
  for (const tool of ["repository", "account"] as const)
    await loadCommand(false)(
      services,
      { commandTimeoutMs: 1000, maxOutputBytes: 1000 },
      {},
      tool,
      "configured-wrapper",
      ["observe"],
    );
  expect(calls).toEqual({ repository: 1, account: 1, generic: 0 });
  await refused(
    loadCommand(true)(
      services,
      { commandTimeoutMs: 1000, maxOutputBytes: 1000 },
      {},
      "repository",
      "configured-wrapper",
      ["observe"],
    ),
    "ACCOUNT_COMMAND_FAILED",
  );
  expect(calls).toEqual({ repository: 1, account: 1, generic: 1 });
}, 1000);
