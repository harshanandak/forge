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

test("GitHub script rendering pins interpreter and tools while filtering ambient identity overrides", () => {
  const tool = createGithubCommandPort(fakeProcess([]));
  const scripts = tool.scripts({
    account: "selected",
    gitPath: "/trusted/bin/git",
    ghPath: "/trusted/bin/gh",
    ghArgs: ["prefix with spaces"],
    envPath: "/trusted/bin/env",
    shellPath: "C:/Program Files/Git/bin/sh.exe",
    environmentNames: ["Path", "GH_TOKEN", "GIT_DIR", "UNSAFE-NAME"],
    allowedGhCommands: ["api user", "auth token"],
    accountKey: "forge.githubAccount",
    marker: "# owned account route",
    windows: true,
  });
  for (const text of [scripts.router, scripts.credential]) {
    expect(text).toStartWith(
      "#!/bin/sh\n# owned account route\nexec '/trusted/bin/env' -i ",
    );
    expect(text).toContain("/trusted/bin/env");
    expect(text).toContain("/trusted/bin/git");
    expect(text).toContain("/trusted/bin/gh");
    expect(text).toContain("'C:/Program Files/Git/bin/sh.exe' -c ");
    expect(text).toContain("export GH_TOKEN GH_HOST");
    expect(text).not.toContain('GH_TOKEN="$GH_TOKEN"');
    expect(text).toContain('PATH="${Path-${PATH-}}"');
    expect(text).not.toContain("GIT_DIR=");
    expect(text).not.toContain('GH_TOKEN="${GH_TOKEN-}"');
    expect(text).not.toContain("UNSAFE-NAME");
  }
  expect(scripts.router).not.toContain("auth:token");
  expect(scripts.router).toContain("api:user");
});

test("shared bootstrap strips configured shell startup variables before invoking the pinned interpreter", () => {
  const tool = createGithubCommandPort(fakeProcess([]));
  const blocked = [
    "BASH_ENV",
    "eNv",
    "SHELLOPTS",
    "bashopts",
    "ZDOTDIR",
    "BASH_FUNC_attack",
    "bash_func_other",
  ];
  const text = tool.bootstrap({
    body: 'printf "%s" "$1"',
    envPath: "/trusted/env",
    shellPath: "/trusted/shell path",
    environmentNames: ["PATH", ...blocked],
    marker: "# hook",
    windows: false,
  });
  expect(text).toContain("exec '/trusted/env' -i PATH=");
  expect(text).toContain("'/trusted/shell path' -c ");
  for (const name of blocked) expect(text).not.toContain(name);
  expect(text).toContain('forge-account "$@"');
});
