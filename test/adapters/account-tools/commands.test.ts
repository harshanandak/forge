import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, setDefaultTimeout, test } from "bun:test";
import { createVcsCommandPort } from "../../../src/adapters/vcs-git/commands.ts";
import { createGithubCommandPort } from "../../../src/adapters/github-cli/index.ts";
import type { ToolCommandPort } from "../../../src/ports/tool-command.ts";
import { fakeProcess, result } from "../process/fake-process.ts";
import type { RecordedRun } from "../process/fake-process.ts";

setDefaultTimeout(5000);
const options = {
  cwd: "/project",
  env: { PATH: "/tools", EXACT: "yes" },
  timeoutMs: 900,
  maxOutputBytes: 100,
  stdin: "input",
};
function contract(
  name: string,
  make: (available: boolean) => { port: ToolCommandPort; runs: RecordedRun[] },
): void {
  test(`${name} command contract forwards explicit executable, argv and budgets`, async () => {
    const { port: tool, runs } = make(true);
    expect(tool.resolve("configured-tool", options.env)).toEqual({
      kind: "resolved",
      path: "/fake/bin/configured-tool",
    });
    expect(
      await tool.run(
        "configured-tool",
        ["arg with spaces", "--literal"],
        options,
      ),
    ).toMatchObject({ stdout: "reply" });
    expect(runs).toEqual([
      {
        executable: "/fake/bin/configured-tool",
        args: ["arg with spaces", "--literal"],
        options,
      },
    ]);
  });
  test(`${name} missing tool returns typed unavailable without spawning`, async () => {
    const { port, runs } = make(false);
    expect(await port.run("missing", [], options)).toMatchObject({
      kind: "unavailable",
    });
    expect(runs).toHaveLength(0);
  });
}
for (const [name, factory] of [
  ["Git", createVcsCommandPort],
  ["GitHub", createGithubCommandPort],
] as const)
  contract(name, (available) => {
    const process = fakeProcess(available ? ["configured-tool"] : [], () => ({
      stdout: "reply",
    }));
    return { port: factory(process), runs: process.runs };
  });
contract("In-memory", (available) => {
  const runs: RecordedRun[] = [];
  const unavailable = {
    kind: "unavailable" as const,
    reason: "missing",
    remedy: "provide a tool",
  };
  return {
    runs,
    port: {
      resolve: (program) =>
        available
          ? { kind: "resolved", path: `/fake/bin/${program}` }
          : unavailable,
      run(program, args, options) {
        if (!available) return Promise.resolve(unavailable);
        runs.push({ executable: `/fake/bin/${program}`, args, options });
        return Promise.resolve(result({ stdout: "reply" }));
      },
    },
  };
});

test("credential mode refuses before resolution or launch", async () => {
  const process = fakeProcess(["gh"]);
  const tool = createGithubCommandPort(process);
  expect(
    await tool
      .run("gh", [], {
        ...options,
        credential: {
          token: "fixture-only",
          pinnedGit: "/trusted/git",
          ownedConfigDir: "/empty/config",
          ownedDataDir: "/empty/data",
        },
      })
      .catch((error: unknown) => error),
  ).toMatchObject({ error: { code: "ACCOUNT_CREDENTIAL_UNSUPPORTED" } });
  expect(process.runs).toHaveLength(0);
});

test("cross-block ownership keeps metadata private and hook installation in git", () => {
  const forbidden = (owner: string, text: string) =>
    (owner !== "github-accounts" &&
      /forge-accounts\/(?:config|metadata\.json)/.test(text)) ||
    (owner !== "git" && /["']hook\.install["']\s*:/.test(text));
  expect(forbidden("other", 'read("forge-accounts/metadata.json")')).toBe(true);
  expect(forbidden("other", '{"hook.install": {}}')).toBe(true);
  const root = new URL("../../../src/blocks/", import.meta.url);
  for (const path of readdirSync(root, { recursive: true, encoding: "utf8" }))
    if (/\.(?:ts|cts|json)$/.test(path))
      expect(
        forbidden(
          path.split(/[\\/]/)[0]!,
          readFileSync(join(fileURLToPath(root), path), "utf8"),
        ),
        path,
      ).toBe(false);
});
