import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const payloadDir = mkdtempSync(join(tmpdir(), "forge-526-payloads-"));
let payloadNumber = 0;
afterAll(() => rmSync(payloadDir, { recursive: true, force: true }));
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
  "echo $mixedSecret",
  "printenv -- api_passwd",
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
  const file = join(payloadDir, `${payloadNumber++}.json`);
  writeFileSync(file, input);
  const fd = openSync(file, "r");
  try {
    return spawnSync(executable, args, {
      cwd: tmpdir(),
      env,
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
  } finally {
    closeSync(fd);
    rmSync(file);
  }
}

const localRoundOne: [string, [string, number, string?][]][] = [
  [
    "reader operands",
    [
      ["grep credentials src/", 0],
      ['rg -n "id_rsa" docs', 0],
      ["egrep credentials src/", 0],
      ["fgrep credentials src/", 0],
      ["awk credentials src/", 0],
      ["sed credentials src/", 0],
      ["jq credentials src/", 0],
      ["grep -e credentials src/", 0],
      ["rg -f patterns.txt src/", 0],
      ["awk -f program.awk src/", 0],
      ["sed -e credentials src/", 0],
      ["grep x .env", 2, "secret-file"],
      ["cat credentials", 2, "secret-file"],
      ["grep -e x .env", 2, "secret-file"],
      ["rg -f patterns.txt .env", 2, "secret-file"],
      ["awk -f program.awk .env", 2, "secret-file"],
      ["sed -e x .env", 2, "secret-file"],
      ["jq . .env", 2, "secret-file"],
      ["grep credentials < .env", 2, "secret-file"],
      ["grep -f .env src/", 2, "secret-file"],
      ["sed -f .env src/", 2, "secret-file"],
      ["grep --file=.env src/", 2, "secret-file"],
      ["grep -- credentials src/", 0],
      ["grep -- x .env", 2, "secret-file"],
    ],
  ],
  [
    "expandable references",
    [
      ["echo '$PLACEHOLDER_SECRET'", 0],
      ["echo \\$PLACEHOLDER_SECRET", 0],
      ["printf '%s' '$PLACEHOLDER_TOKEN'", 0],
      ['echo "\\$API_TOKEN"', 0],
      ['echo "${API_TOKEN}"', 2, "secret-variable"],
      ["echo $API_TOKEN", 2, "secret-variable"],
      ["echo '$API_'TOKEN", 0],
      ['echo "$API_"TOKEN', 0],
      ["echo '$PATH' $API_TOKEN", 2, "secret-variable"],
    ],
  ],
  [
    "outer substitution words",
    [
      ['echo "$(date) $API_TOKEN"', 2, "secret-variable"],
      ["echo $(true) $API_TOKEN", 2, "secret-variable"],
      ['echo "$(printf ordinary)" "$PLACEHOLDER_SECRET"', 2, "secret-variable"],
      ['echo "`date` $API_TOKEN"', 2, "secret-variable"],
      ["echo `true` $API_TOKEN", 2, "secret-variable"],
      ["printf %s $(true) $API_TOKEN", 2, "secret-variable"],
      ['echo "$(date) \\$API_TOKEN"', 0],
      ["echo $(true) '$API_TOKEN'", 0],
      ['echo "$( (true); printf ordinary )"', 0],
    ],
  ],
  [
    "line continuations",
    [
      ["en\\\nv", 2, "env-dump"],
      ['"en\\\nv"', 2, "env-dump"],
      ["echo $API_\\\nTOKEN", 2, "secret-variable"],
      ["git sta\\\ntus", 0],
      ["echo 'en\\\nv'", 0],
    ],
  ],
  [
    "executable suffixes",
    [
      ["env.exe", 2, "env-dump"],
      ["/usr/bin/PRINTENV.EXE", 2, "env-dump"],
      ["sudo env.exe", 2, "env-dump"],
      ["cat.exe .env", 2, "secret-file"],
      ["printenv.exe HOME", 0],
      ["env.exe FOO=1 bun test", 0],
      ["cat credentials.exe", 0],
    ],
  ],
];
const localRoundTwo: typeof localRoundOne = [
  [
    "value-taking reader options",
    [
      ...["grep", "egrep", "fgrep"].flatMap((reader) =>
        [
          "-m",
          "-A",
          "-B",
          "-C",
          "--max-count",
          "--after-context",
          "--before-context",
          "--context",
        ].map((option): [string, number] => [
          `${reader} ${option} 1 credentials src/`,
          0,
        ]),
      ),
      ["grep --max-count=1 credentials src/", 0],
      ["grep -m1 credentials src/", 0],
      ["rg -m 1 credentials src/", 0],
      ["rg -g '*.txt' credentials src/", 0],
      ["rg --glob '*.txt' credentials src/", 0],
      ["rg -t txt credentials src/", 0],
      ["rg --type txt credentials src/", 0],
      ["jq --arg x credentials . input.json", 0],
      ["jq --argjson x 1 credentials input.json", 0],
      ["awk -v x=1 credentials src/", 0],
      ["awk -F : credentials src/", 0],
      ["grep -m 1 x .env", 2, "secret-file"],
      ["rg -g '*.txt' x credentials", 2, "secret-file"],
      ["jq --arg x ordinary . credentials", 2, "secret-file"],
      ["awk -v x=1 '{print}' credentials", 2, "secret-file"],
      ["grep x .env", 2, "secret-file"],
      ["cat credentials", 2, "secret-file"],
    ],
  ],
  [
    "here-document bodies are text",
    [
      ["git commit -F - <<EOF\nenv\ncat credentials\nEOF", 0],
      ["git commit -F - <<'EOF'\nenv\ncat credentials\nEOF", 0],
      ['git commit -F - <<"EOF"\nenv\nEOF', 0],
      ["git commit -F - <<-EOF\n\tenv\n\tEOF", 0],
      ["git commit -F - << EOF\nenv\nEOF", 0],
      ["cat <<'EOF'\nenv\nEOF", 0],
      ["cat <<A <<'B'\nenv\nA\ncat credentials\nB", 0],
      ["echo '<<EOF'; env", 2, "env-dump"],
      ["env <<EOF\nordinary text\nEOF", 2, "env-dump"],
      ["cat credentials <<EOF\nordinary text\nEOF", 2, "secret-file"],
      ["cat <<EOF\nordinary text\nEOF\nenv", 2, "env-dump"],
      ["cat <<EOF; env\nordinary text\nEOF", 2, "env-dump"],
    ],
  ],
];
const reviewRoundOne: typeof localRoundOne = [
  [
    "jq flags",
    [
      ["jq -e . credentials.json", 2, "secret-file"],
      ["jq --exit-status . credentials.json", 2, "secret-file"],
      ["jq -e .name package.json", 0],
    ],
  ],
  [
    "jq program files",
    [
      ["jq -f filter.jq .env", 2, "secret-file"],
      ["jq --from-file filter.jq .env", 2, "secret-file"],
      ["jq -f filter.jq package.json", 0],
      ["jq -f credentials.json package.json", 2, "secret-file"],
    ],
  ],
  [
    "jq data files",
    [
      ["jq -n --rawfile s .env '$s'", 2, "secret-file"],
      ["jq -n --slurpfile s credentials.json '$s'", 2, "secret-file"],
      ["jq -n --rawfile s README.md '$s'", 0],
      ["jq --arg s credentials.json . package.json", 0],
    ],
  ],
  [
    "documented reader options",
    [
      ...[
        ["--max-filesize", "1M"],
        ["--context-separator", "sep"],
        ["--path-separator", "/"],
        ["--dfa-size-limit", "1M"],
        ["--regex-size-limit", "1M"],
        ["--field-context-separator", "sep"],
        ["--field-match-separator", "sep"],
        ["--hostname-bin", "hostname"],
        ["--hyperlink-format", "none"],
        ["--generate", "man"],
        ["-d", "1"],
        ["--maxdepth", "1"],
        ["-M", "100"],
        ["--max-columns", "100"],
        ["-j", "1"],
        ["--threads", "1"],
        ["--type-add", "custom:*.txt"],
        ["--type-clear", "txt"],
        ["--sort", "path"],
        ["--sortr", "path"],
        ["--color", "never"],
        ["--colors", "match:none"],
        ["-E", "utf-8"],
        ["--encoding", "utf-8"],
        ["--engine", "default"],
        ["-g", "*.txt"],
        ["--glob", "*.txt"],
        ["--iglob", "*.txt"],
        ["-t", "txt"],
        ["--type", "txt"],
        ["-T", "txt"],
        ["--type-not", "txt"],
        ["-m", "1"],
        ["--max-count", "1"],
        ["-A", "1"],
        ["--after-context", "1"],
        ["-B", "1"],
        ["--before-context", "1"],
        ["-C", "1"],
        ["--context", "1"],
        ["--max-depth", "1"],
        ["--ignore-file", "ignore.txt"],
        ["--pre", "processor"],
        ["--pre-glob", "*.txt"],
        ["-r", "replacement"],
        ["--replace", "replacement"],
      ].flatMap(([option, value]): [string, number, string?][] => [
        [`rg ${option} ${value} credentials src/`, 0],
        [`rg ${option} ${value} x .env`, 2, "secret-file"],
        ...(option!.startsWith("--")
          ? [[`rg ${option}=${value} credentials src/`, 0] as [string, number]]
          : []),
      ]),
      ...["grep", "egrep", "fgrep"].flatMap((reader) =>
        [
          ["-m", "1"],
          ["-A", "1"],
          ["-B", "1"],
          ["-C", "1"],
          ["-d", "skip"],
          ["-D", "skip"],
          ["--max-count", "1"],
          ["--after-context", "1"],
          ["--before-context", "1"],
          ["--context", "1"],
          ["--group-separator", "sep"],
          ["--include", "*.txt"],
          ["--exclude", "*.txt"],
          ["--exclude-from", "ignore.txt"],
          ["--exclude-dir", "vendor"],
          ["--label", "input"],
          ["--binary-files", "text"],
          ["--devices", "skip"],
          ["--directories", "skip"],
        ].flatMap(([option, value]): [string, number, string?][] => [
          [`${reader} ${option} ${value} credentials src/`, 0],
          [`${reader} ${option} ${value} x .env`, 2, "secret-file"],
          ...(option!.startsWith("--")
            ? [
                [`${reader} ${option}=${value} credentials src/`, 0] as [
                  string,
                  number,
                ],
              ]
            : []),
        ]),
      ),
      ["rg -e credentials src/", 0],
      ["rg --regexp=credentials src/", 0],
      ["rg -f patterns.txt .env", 2, "secret-file"],
      ["grep -e credentials src/", 0],
      ["grep --regexp=credentials src/", 0],
      ["grep -f patterns.txt .env", 2, "secret-file"],
      ["rg x .env", 2, "secret-file"],
    ],
  ],
  [
    "unquoted heredoc expansions",
    [
      ["cat <<EOF\n$API_KEY\nEOF", 2, "secret-variable"],
      ["cat <<EOF\n${API_KEY}\nEOF", 2, "secret-variable"],
      ["cat <<EOF\n$(printenv)\nEOF", 2, "env-dump"],
      ["cat <<EOF\n`printenv`\nEOF", 2, "env-dump"],
      ["cat <<-EOF\n\t$API_KEY\n\tEOF", 2, "secret-variable"],
      ["cat <<EOF\nplain env and cat credentials\nEOF", 0],
      ["cat <<'EOF'\n$API_KEY $(printenv) `printenv`\nEOF", 0],
      ['cat <<"EOF"\n$API_KEY $(printenv) `printenv`\nEOF', 0],
      ["cat <<\\EOF\n$API_KEY $(printenv) `printenv`\nEOF", 0],
      ["cat <<EOF\n\\$API_KEY \\$(printenv)\nEOF", 0],
      ['cat <<EOF\n"$API_KEY"\nEOF', 2, "secret-variable"],
    ],
  ],
  [
    "secret names and presence",
    [
      ['for key in a b; do echo "$key"; done', 0],
      ["echo ${API_KEY:+set}", 0],
      ["echo ${#API_KEY}", 0],
      ["echo $mixedSecret", 0],
      ["printenv api_passwd", 0],
      ["echo $API_KEY", 2, "secret-variable"],
      ["echo ${API_KEY}", 2, "secret-variable"],
      ["echo ${API_KEY:+$OTHER_SECRET}", 2, "secret-variable"],
      ["echo $API_KEY_2", 2, "secret-variable"],
    ],
  ],
  [
    "cut key names",
    [
      ["cut -s -d= -f1 .env", 0],
      ["cut -s -d = -f 1 .env", 0],
      ["cut --only-delimited --delimiter = --fields 1 .env", 0],
      // A multi-line value (a quoted PEM key) has lines with no "=", which cut prints whole without -s.
      ["cut -d= -f1 .env", 2, "secret-file"],
      ["cut -d = -f 1 .env", 2, "secret-file"],
      ["cut -d= -f1 < .env", 2, "secret-file"],
      ["cut --fields=1 .env", 2, "secret-file"],
      ["cut -f1 < .env", 2, "secret-file"],
      ["cut -f1 .env", 2, "secret-file"],
      ["cut -s -d: -f1 .env", 2, "secret-file"],
      ["cut -s -d= -f1 ~/.ssh/id_rsa", 2, "secret-file"],
      ["cut -s -d= -f1-2 .env", 2, "secret-file"],
      ["cut -s -d '=' -f1 .env", 0],
      ['cut -s -d"=" -f1 .env', 0],
      ["cut -s --delimiter== -f1 .env", 0],
      ["cut -s --delimiter '=' -f1 .env", 0],
      ["cut -s -d= -f1 < .env", 0],
      ["cut -d= -f1 -s .env.local", 0],
      ["cut -d= -f1 README.md", 0],
      ...[
        "cert.pem",
        "cert.p12",
        "cert.pfx",
        "secret.key",
        "credentials",
        ".netrc",
        "~/.codex/auth.json",
        ".env.pem",
      ].map((file): [string, number, string] => [
        `cut -s -d= -f1 ${file}`,
        2,
        "secret-file",
      ]),
      ["cut -s -d= -f1 .env credentials", 2, "secret-file"],
      ["cut -s -d= --complement -f1 .env", 2, "secret-file"],
      ["cut -f2 .env", 2, "secret-file"],
      ["cut -f1,2 .env", 2, "secret-file"],
      ["cut -f1- .env", 2, "secret-file"],
      ["cut -f2 < .env", 2, "secret-file"],
      ["cut -c1 .env", 2, "secret-file"],
    ],
  ],
  [
    "command lookup",
    [
      ["command -v env", 0],
      ["command -V printenv", 0],
      ["command -pv env", 0],
      ["command env", 2, "env-dump"],
    ],
  ],
];
for (const harness of ["claude", "codex"])
  for (const [decision, rows] of reviewRoundOne)
    for (const [index, [command, status, rule]] of rows.entries())
      test(`${harness} review round one ${decision}: ${index}`, () => {
        const result = run(payload(harness, command));
        expect({ command, status: result.status }).toEqual({ command, status });
        expect(result.stdout).toBe("");
        if (rule)
          expect(result.stderr).toMatch(
            new RegExp(`^Forge guard refused \\(${rule}\\): [^\\r\\n]+\\n$`),
          );
        else expect(result.stderr).toBe("");
      });
for (const harness of ["claude", "codex"])
  for (const [decision, rows] of [...localRoundOne, ...localRoundTwo]) {
    test(`${harness} local regression: ${decision}`, () => {
      for (const [command, status, rule] of rows) {
        const result = run(payload(harness, command));
        expect({ command, status: result.status }).toEqual({ command, status });
        expect(result.stdout).toBe("");
        if (rule)
          expect(result.stderr).toMatch(
            new RegExp(`^Forge guard refused \\(${rule}\\): [^\\r\\n]+\\n$`),
          );
        else expect(result.stderr).toBe("");
      }
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
