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
  return { calls, writes, config, services };
}
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
