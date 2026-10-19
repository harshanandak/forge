import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { renderAccountScripts } from "../../../src/adapters/github-cli/scripts.ts";
import type { AccountScriptsOptions } from "../../../src/ports/tool-command.ts";

test("Git Bash canonicalized OS names survive an isolated Windows child environment", () => {
  const config: AccountScriptsOptions = {
    account: "fixture",
    gitPath: "/trusted/repository-tool",
    ghPath: "/trusted/account-tool",
    ghArgs: [],
    envPath: "/trusted/env",
    shellPath: "/trusted/shell with spaces",
    allowedGhCommands: ["pr create"],
    accountKey: "forge.githubAccount",
    marker: "# fixture",
    windows: true,
    environmentNames: [
      "Path",
      "SystemRoot",
      "FAKE_GH_LOG",
      "GH_TOKEN",
      "GIT_CONFIG_COUNT",
      "BASH_ENV",
      "ENV",
      "SHELLOPTS",
      "BASHOPTS",
    ],
  };
  const windows = renderAccountScripts(config).router;
  expect(windows).toContain('PATH="${Path-${PATH-}}"');
  expect(windows).toContain('SYSTEMROOT="${SystemRoot-${SYSTEMROOT-}}"');
  expect(windows).toContain('FAKE_GH_LOG="${FAKE_GH_LOG-}"');
  expect(windows.includes('GH_TOKEN="${GH_TOKEN-}"')).toBe(false);
  expect(windows.includes("GIT_CONFIG_COUNT=")).toBe(false);
  for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"])
    expect(windows.includes(`${name}="`)).toBe(false);
  expect(windows).toContain("/trusted/env");
  expect(windows.includes("env -i")).toBe(false);
  expect(windows).toContain("exec '/trusted/env' -i ");
  expect(windows).toContain(" '/trusted/shell with spaces' -c ");
  const posix = renderAccountScripts({ ...config, windows: false }).router;
  expect(posix).toContain('Path="${Path-}"');
}, 1000);
test("interrupted staging stays bounded to one marked file and foreign content is preserved", async () => {
  const source = readFileSync(
    new URL("../../../src/blocks/github-accounts/entry.cts", import.meta.url),
    "utf8",
  );
  type Stage = (
    services: unknown,
    config: unknown,
    env: unknown,
    original: string,
    changes: unknown,
  ) => Promise<string>;
  const module = { exports: {} as { stageConfig: Stage } };
  runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      source + "\nmodule.exports = {stageConfig};",
    ),
    {
      module,
      fail: (code: string) => {
        throw Object.assign(new Error(code), { code });
      },
    },
  );
  const marker = "# forge/github-accounts owned staging v1\n",
    path = ".forge-github-accounts/staging.config";
  const files = new Map([[path, marker + "interrupted previous stage"]]);
  const services = {
    files: {
      roots: { common: "/clone/.git" },
      read: (key: string) => files.get(key),
      write: (key: string, text: string) => files.set(key, text),
      remove: (key: string) => files.delete(key),
    },
  };
  expect(
    await module.exports.stageConfig(
      services,
      { maxFileBytes: 10000 },
      {},
      "[core]\n bare = false\n",
      {},
    ),
  ).toBe("[core]\n bare = false\n");
  expect(files.size).toBe(0);
  files.set(path, "foreign content");
  let error: unknown;
  try {
    await module.exports.stageConfig(
      services,
      { maxFileBytes: 10000 },
      {},
      "replacement",
      {},
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "INPUT_CONFLICT" });
  expect(files.get(path)).toBe("foreign content");
}, 1000);
test("pre-push hook delegates interpreter startup to the isolated adapter bootstrap", () => {
  const source = readFileSync(
    new URL("../../../src/blocks/github-accounts/entry.cts", import.meta.url),
    "utf8",
  );
  type Hook = (
    config: unknown,
    launchers: unknown,
    services: unknown,
  ) => string;
  const module = { exports: {} as { hookScript: Hook } };
  runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      source + "\nmodule.exports = {hookScript};",
    ),
    { module },
  );
  let captured: unknown;
  const services = {
    environment: { platform: "linux" },
    account: {
      bootstrap: (options: unknown) => {
        captured = options;
        return "isolated bootstrap";
      },
    },
  };
  expect(
    module.exports.hookScript(
      {
        forgeCommand: ["node", "installed-forge.js"],
        environmentNames: ["PATH", "BASH_ENV"],
      },
      { env: "/trusted/env", shell: "/trusted/bash", forge: "/trusted/node" },
      services,
    ),
  ).toBe("isolated bootstrap");
  expect(captured).toMatchObject({
    envPath: "/trusted/env",
    shellPath: "/trusted/bash",
    windows: false,
  });
}, 1000);
