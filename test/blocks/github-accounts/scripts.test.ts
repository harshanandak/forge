import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("Git Bash canonicalized OS names survive an isolated Windows child environment", () => {
  const source = readFileSync(
    new URL("../../../src/blocks/github-accounts/entry.cts", import.meta.url),
    "utf8",
  );
  const module = {
    exports: {} as {
      scriptEnvironment: (config: unknown, windows: boolean) => string;
    },
  };
  runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      source + "\nmodule.exports = {scriptEnvironment};",
    ),
    { module },
  );
  const config = {
    environmentNames: [
      "Path",
      "SystemRoot",
      "FAKE_GH_LOG",
      "GH_TOKEN",
      "GIT_CONFIG_COUNT",
    ],
  };
  const windows = module.exports.scriptEnvironment(config, true);
  expect(windows).toContain('PATH="${Path-${PATH-}}"');
  expect(windows).toContain('SYSTEMROOT="${SystemRoot-${SYSTEMROOT-}}"');
  expect(windows).toContain('FAKE_GH_LOG="${FAKE_GH_LOG-}"');
  expect(windows.includes("GH_TOKEN=")).toBe(false);
  expect(windows.includes("GIT_CONFIG_COUNT=")).toBe(false);
  const posix = module.exports.scriptEnvironment(config, false);
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
