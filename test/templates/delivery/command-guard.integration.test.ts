import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

setDefaultTimeout(30_000);
const repo = resolve(import.meta.dirname, "../../..");
const script = join(repo, "templates/delivery/harness/guard.mjs");
const node = Bun.which("node")!;
const home =
  process.platform === "win32" ? "C:/Users/guard-canary" : "/home/guard-canary";
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key),
  ),
);
Object.assign(env, { HOME: home, USERPROFILE: home });
const refused: [string, string[]][] = [
  [
    "env-dump",
    [
      "env",
      "printenv",
      "  env  ",
      "sudo env",
      "/usr/bin/env",
      '"env"',
      'e"n"v',
      "\\env",
      "git status && env",
      "true; printenv",
      "false || env",
      "env | grep X",
      "(env)",
      "echo $(printenv)",
      'echo "$( (true); env )"',
      'echo "$(printf ")"; env)"',
      "`env`",
      "set",
      "export -p",
      "declare -p",
      'bash -c "env"',
      "env FOO=1 printenv",
      "env -u FOO",
      "typeset -px",
      "export",
      "printenv --",
      "doas -u root env",
      "! env",
      "if env; then true; fi",
      "env\ntrue",
      "true |& env",
      "env FOO=1",
      "env -i",
      "command builtin exec nohup time env",
      "env > out",
      "printenv > out",
      "export -p > out",
      "set > out",
      "declare -px > out",
      "> out env",
      "env 2> out",
      "env < input > out",
    ],
  ],
  [
    "secret-variable",
    [
      "printenv GITHUB_TOKEN",
      "echo $OPENAI_API_KEY",
      'printf %s "${DB_PASSWORD}"',
      "declare -p APP_CRED",
      "declare -px GITHUB_TOKEN",
      "echo $KEYBOARD",
      "echo $mixedSecret",
      "printenv -- api_passwd",
    ],
  ],
  [
    "secret-file",
    [
      "cat .env",
      "cat ./.env.local",
      "head -n 5 .env.production",
      "less ~/.ssh/id_ed25519",
      "cat < .env",
      "grep KEY .env",
      "cat ~/.aws/credentials",
      "cat ~/.codex/auth.json",
      "cat /proc/self/environ",
      'sudo cat "/srv/a/.env"',
      "cat cert.pem",
      "cat cert.p12",
      "cat cert.pfx",
      "cat secret.key",
      "cat id_rsa",
      "cat id_ecdsa",
      "cat id_dsa",
      "cat credentials.json",
      "cat .credentials.json",
      "cat .git-credentials",
      "cat .netrc",
      "cat > out < .env",
      "rg --files .env",
    ],
  ],
  [
    "provider-env",
    [
      "convex env list",
      "npx convex env list",
      "bunx convex env get X",
      "heroku config",
      "netlify env:list",
      "railway variables",
      "doppler secrets",
      "pnpm dlx convex env list",
      "pnpm exec convex env list",
      "npm exec -- convex env get X",
      "yarn dlx convex env list",
      "heroku config:get X",
      "netlify env:get X",
    ],
  ],
  [
    "rm-root",
    [
      "rm -rf /",
      "rm -rf ~",
      "rm -rf ~/",
      "rm -fr $HOME",
      'rm -rf "${HOME}"',
      "rm -r -f /*",
      "rm -Rf -- ~",
      "rm --recursive --force ~",
      "sudo rm -rf --no-preserve-root /",
      "cd x && rm -rf ~",
      "rm -rf /c/",
      "rm -rf C:/",
      `rm -rf ${home}`,
      "sh -c 'rm -rf ~'",
      "rm -r //./",
      "rm -r ~other",
      "rm --no-preserve-root ./dist",
      "rm -r 'C:\\'",
      ...(process.platform === "win32"
        ? ["rm -r /c/Users/GUARD-CANARY/."]
        : []),
    ],
  ],
];
const allowed = [
  "git status",
  "bun test",
  "env FOO=1 bun test",
  "rm -rf ./dist",
  "rm -rf ~/proj/dist",
  'rm -rf "$HOME/.cache/x"',
  "printenv HOME",
  "echo $PATH",
  "cat .env.example",
  "cp .env.example .env",
  "rm .env",
  "set -euo pipefail",
  "export FOO=1",
  'echo "cat .env"',
  'git commit -m "mention env and rm -rf ~"',
  "convex deploy",
  "cat .env.sample",
  "cat .env.template",
  "cat .env.dist",
  "cat id_rsa.pub",
  "cat > .env",
  "echo harmless > .env",
  "env -u FOO bun test",
  "rm -f ~",
  "printf %s harmless",
  "cat README.md",
  'echo "$( (true); printf ordinary )"',
];
function payload(harness: string, command: unknown) {
  return JSON.stringify({
    session_id: "fixture",
    transcript_path: null,
    cwd: tmpdir(),
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "canary-do-not-echo", timeout: 1000 },
    tool_use_id: "fixture",
    ...(harness === "codex" ? { turn_id: "fixture", model: "fixture" } : {}),
  });
}
function run(input: string, executable = node, args = [script]) {
  return spawnSync(executable, args, {
    cwd: tmpdir(),
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
}
for (const harness of ["claude", "codex"]) {
  for (const [rule, commands] of refused)
    for (const command of commands) {
      test(`${harness} refuses ${rule}: ${command}`, () => {
        const result = run(payload(harness, `${command} # canary-do-not-echo`));
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(
          new RegExp(`^Forge guard refused \\(${rule}\\): [^\\r\\n]+\\n$`),
        );
        expect(result.stderr).not.toContain("canary");
        expect(result.stderr).not.toContain(home);
        expect(result.stderr).not.toContain("HOME");
        expect(result.stderr).not.toMatch(
          /GITHUB_TOKEN|OPENAI_API_KEY|DB_PASSWORD|APP_CRED|KEYBOARD|mixedSecret|api_passwd/,
        );
      });
    }
  for (const command of allowed)
    test(`${harness} allows ${command}`, () => {
      const result = run(payload(harness, command));
      expect([result.status, result.stdout, result.stderr]).toEqual([
        0,
        "",
        "",
      ]);
    });
  test(`${harness} refuses unsupported Bash payloads`, () => {
    for (const command of [42, null, {}, undefined]) {
      const result = run(payload(harness, command));
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        /^Forge guard refused \(unsupported-payload\): [^\r\n]+\n$/,
      );
    }
  });
}
test("unreadable and other-tool payloads pass silently", () => {
  for (const input of [
    "not JSON",
    "null",
    "[]",
    "42",
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: ".env" } }),
  ]) {
    const result = run(input);
    expect([result.status, result.stdout, result.stderr]).toEqual([0, "", ""]);
  }
});
test("the exact rendered command runs through the platform shell for both harnesses", () => {
  const operations = require("../../../src/blocks/agent/entry.cts") as Record<
    string,
    (call: unknown) => {
      config: {
        hooks: {
          PreToolUse: { matcher: string; hooks: { command: string }[] }[];
        };
      };
    }
  >;
  const result = operations["agent.guard"]!({
    input: { id: "fixture" },
    config: {
      adapters: [
        {
          id: "fixture",
          detect: [],
          guard: {
            kind: "hook",
            file: "unused",
            stop: "Stop",
            command: "PreToolUse",
          },
        },
      ],
    },
    services: {
      environment: {
        packageRoot: repo,
        platform: process.platform,
        select: () => ({}),
      },
    },
  });
  expect(result.config.hooks.PreToolUse).toBeDefined();
  const group = result.config.hooks.PreToolUse[0]!;
  expect(group.matcher).toBe("Bash");
  let shell = "/bin/sh";
  if (process.platform === "win32") {
    const git = spawnSync("git", ["--exec-path"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(git.status).toBe(0);
    shell = join(dirname(dirname(dirname(git.stdout.trim()))), "bin/bash.exe");
    expect(shell.toLowerCase()).not.toContain("system32");
  }
  expect(existsSync(shell)).toBe(true);
  for (const harness of ["claude", "codex"])
    for (const [command, status] of [
      ["printenv", 2],
      ["git status", 0],
    ] as const) {
      const checked = run(payload(harness, command), shell, [
        "-c",
        group.hooks[0]!.command,
      ]);
      expect(checked.status).toBe(status);
      expect(checked.stdout).toBe("");
      if (status === 0) expect(checked.stderr).toBe("");
      else expect(checked.stderr).toMatch(/^Forge guard refused \(env-dump\):/);
    }
});
