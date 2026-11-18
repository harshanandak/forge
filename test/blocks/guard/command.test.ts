import assert from "node:assert/strict";
import { setDefaultTimeout, test } from "bun:test";
import {
  checkCommand,
  evaluateCommand,
  extractCommand,
  makeBound,
  MAX_COMMAND_LENGTH,
  RULES,
} from "../../../src/blocks/guard/command.ts";
import { powerShellArgs } from "../../powershell.ts";
import {
  hookBypassCommand,
  retiredRuleId,
  retiredTrackerCommand,
} from "./fixtures/legacy.ts";

setDefaultTimeout(10_000);

const byId = (id: string) => RULES.find((rule) => rule.id === id)!.test;

function powerShellCommand(command: string): string {
  return ["powershell", ...powerShellArgs(command)].join(" ");
}

function runGuard(input: unknown, raw = false) {
  if (raw) {
    try {
      input = JSON.parse(String(input));
    } catch {
      input = null;
    }
  }
  return checkCommand(input) as {
    permission?: "deny";
    hookSpecificOutput: {
      permissionDecision: "deny";
      permissionDecisionReason: string;
    };
  };
}

function matches(value: unknown, expression: RegExp): void {
  assert.equal(typeof value, "string");
  assert.match(value as string, expression);
}

function doesNotMatch(value: unknown, expression: RegExp): void {
  assert.equal(typeof value, "string");
  assert.doesNotMatch(value as string, expression);
}

test("carries the H1, H7, and H8 BLOCK rules plus the H5, H6, H12 WARN rules", () => {
  assert.deepEqual(RULES.map((r) => r.id).sort(), [
    "H1-secrets-bash",
    "H12-cd-chain",
    "H5-worktree",
    retiredRuleId,
    "H7-hook-bypass",
    "H8-live-destructive",
  ]);
  const actions = Object.fromEntries(RULES.map((r) => [r.id, r.action]));
  assert.deepEqual(actions, {
    "H1-secrets-bash": "block",
    "H7-hook-bypass": "block",
    "H8-live-destructive": "block",
    "H5-worktree": "warn",
    [retiredRuleId]: "warn",
    "H12-cd-chain": "warn",
  });
});

test("H1 blocks credential reads but allows writes into secret files", () => {
  const h1 = byId("H1-secrets-bash");
  assert.ok(h1("cat ~/.agent-secrets/.env"));
  assert.ok(h1("env"));
  assert.ok(h1("echo $N8N_API_KEY"));
  assert.equal(
    h1(
      'cat src/codex-quota.mjs; python -c "env:mergeProcessEnv({...(resolvedLaunch.environment||{}),...extraEnv})"',
    ),
    null,
  );
  assert.ok(
    h1(
      'cat src/codex-quota.mjs; python -c "env:mergeProcessEnv({...(resolvedLaunch.env||{}),...env})"',
    ),
  );
  assert.ok(h1("cat /tmp/.env"));
  assert.ok(h1("cat /tmp/prod.env"));
  assert.ok(h1("Get-Content prod.env"));
  assert.ok(h1('cat "C:\\tmp\\prod.env"'));
  assert.ok(h1("Get-Content 'C:\\tmp\\prod.env'"));
  assert.ok(h1("cat .env.production"));
  assert.ok(h1("cat README.md; cat /tmp/prod.env"));
  assert.ok(h1('cat "README;notes.txt"; cat "C:\\tmp\\prod.env"'));
  assert.ok(h1("cat README.md; cat /tmp/prod.env > /tmp/output.txt"));
  assert.ok(h1("cat /tmp/prod.env; echo ok > /tmp/unrelated.env"));
  assert.ok(h1("cat > /tmp/output.txt /tmp/prod.env"));
  assert.ok(h1("cat README.md > /tmp/output.txt /tmp/prod.env"));
  assert.ok(h1('cat README.md >> "output;notes.env" /tmp/prod.env'));
  assert.ok(h1("cat README.md 2> /tmp/errors.txt /tmp/prod.env"));
  assert.ok(h1("cat 2>&1 /tmp/prod.env"));
  assert.ok(h1("cat >/tmp/output</tmp/prod.env"));
  assert.ok(h1('cat > "output;notes.txt" < "input.env"'));
  assert.equal(h1("cat README.md > /tmp/output.env"), null);
  assert.equal(h1('cat README.md >> "output.env"'), null);
  assert.equal(h1('cat README.md 2> "errors.env"'), null);
  assert.equal(h1('cat > "output;notes.txt" README.md'), null);
  assert.equal(h1("cat .env.example"), null);
  assert.equal(h1("cat .env.sample"), null);
  assert.equal(h1("cat .env.template"), null);
  assert.equal(h1("cat .env.dist"), null);
  assert.equal(
    h1(
      "cat src/file.txt; python -c \"print('resolvedLaunch.environment from source text')\"",
    ),
    null,
  );
  assert.ok(
    h1(
      "cat src/file.txt; python -c \"print('resolvedLaunch.env from source text')\"",
    ),
  );
  assert.equal(
    h1("cat src/file.txt; python -c \"print('property env with spaces')\""),
    null,
  );
  assert.equal(h1("echo hello world"), null);
  assert.equal(h1("echo $HOME"), null);
});

test("H1 blocks raw searches and harness state copies without blocking source references", () => {
  const h1 = byId("H1-secrets-bash");
  assert.ok(h1("rg -n harmless ~/.codex/.codex-global-state.json"));
  assert.ok(
    h1(
      "Get-Content C:/Users/demo/.codex/..codex-global-state.json.bak.tmp-fixture",
    ),
  );
  assert.ok(h1("Get-Content C:/tmp/.codex-global-state.json.bak"));
  assert.ok(h1("Get-Content '.codex-global-state.json.tmp'"));
  assert.ok(h1("rg harmless C:/tmp/.codex-global-state.json.bak"));
  assert.ok(h1("grep harmless ~/.claude/history.jsonl.bak"));
  assert.ok(
    h1(
      "findstr harmless C:\\Users\\demo\\.codex\\sessions\\rollout-fixture.jsonl.tmp",
    ),
  );
  assert.ok(
    h1(
      "findstr /c:harmless C:\\Users\\demo\\.codex\\sessions\\rollout-fixture.jsonl.tmp",
    ),
  );
  assert.ok(
    h1(
      "Select-String -Pattern harmless -Path '~/.config/opencode/auth.json.backup'",
    ),
  );
  assert.ok(h1("Get-Content ~/.cursor/globalStorage/state.vscdb.old"));
  assert.ok(h1("rg -a harmless ~/.codex"));
  assert.ok(h1("rg -eharmless ~/.codex"));
  assert.ok(h1("rg -- harmless ~/.codex"));
  assert.equal(h1('rg -n "auth.json" src'), null);
  assert.equal(h1('rg -a ".codex" src'), null);
  assert.equal(h1('rg -- ".codex"'), null);
  assert.equal(h1('rg -g "*.js" ".codex" src'), null);
  assert.equal(h1("cat scripts/safe-inspect.js"), null);
  assert.equal(
    h1("node scripts/safe-inspect.js ~/.codex/.codex-global-state.json"),
    null,
  );
  assert.equal(
    h1(
      'set -a; . ~/.agent-secrets/.env; set +a; curl -H "Authorization: Bearer $SERVICE_TOKEN" https://example.test',
    ),
    null,
  );
  assert.equal(
    h1("Set-Content -LiteralPath ~/.agent-secrets/.env -Value $fixture"),
    null,
  );
});

test("extracts command and cmd only from supported shell envelopes", () => {
  assert.equal(
    extractCommand({ tool_name: "Bash", tool_input: { command: "echo ok" } }),
    "echo ok",
  );
  assert.equal(
    extractCommand({
      tool_name: "exec_command",
      tool_input: { cmd: "echo ok" },
    }),
    "echo ok",
  );
  assert.equal(
    extractCommand({ tool_name: "Shell", command: "echo ok" }),
    "echo ok",
  );
  assert.equal(
    extractCommand({
      tool_name: "functions.exec",
      tool_input: { code: "await tools.exec_command({cmd: 'echo ok'})" },
    }),
    "",
  );
});

test("Hook blocks command/cmd payloads and typed reads/searches of protected state", () => {
  const bash = runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat ~/.agent-secrets/.env" },
  });
  assert.equal(bash.hookSpecificOutput.permissionDecision, "deny");

  const execCommand = runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "functions.exec_command",
    tool_input: { cmd: "rg harmless ~/.codex/.codex-global-state.json" },
  });
  assert.equal(execCommand.hookSpecificOutput.permissionDecision, "deny");

  const cursor = runGuard({
    tool_name: "Shell",
    command: "Get-Content ~/.claude/history.jsonl",
  });
  assert.equal(cursor.permission, "deny");
  const cursorNative = runGuard({
    hook_event_name: "preToolUse",
    cursor_version: "fixture",
    tool_name: "Read",
    tool_input: { path: "/fixture/.agent-secrets/.env" },
  });
  assert.equal(cursorNative.permission, "deny");

  const read = runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "~/.config/opencode/auth.json" },
  });
  assert.equal(read.hookSpecificOutput.permissionDecision, "deny");

  const grep = runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Grep",
    tool_input: { pattern: "harmless", path: "~/.codex/sessions" },
  });
  assert.equal(grep.hookSpecificOutput.permissionDecision, "deny");

  const search = runGuard({
    tool_name: "Search",
    pattern: "harmless",
    path: "~/.claude/backups",
  });
  assert.equal(search.permission, "deny");
});

test("Hook allows authenticated use, writes, project searches, and unrelated typed tools", () => {
  assert.deepEqual(
    runGuard({
      hook_event_name: "PreToolUse",
      tool_name: "exec_command",
      tool_input: {
        cmd: 'set -a; . ~/.agent-secrets/.env; set +a; curl -H "Authorization: Bearer $SERVICE_TOKEN" https://example.test',
      },
    }),
    {},
  );
  assert.deepEqual(
    runGuard({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "~/.agent-secrets/.env",
        content: "fixture-only",
      },
    }),
    {},
  );
  assert.deepEqual(
    runGuard({
      hook_event_name: "PreToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "auth.json", path: "src" },
    }),
    {},
  );
  assert.deepEqual(
    runGuard({ tool_name: "Status", tool_input: { detail: "metadata" } }),
    {},
  );
  assert.deepEqual(
    runGuard({ tool_name: "Status", tool_input: { command: "" } }),
    {},
  );
  assert.deepEqual(
    runGuard({
      tool_name: "functions.exec",
      tool_input: {
        code: "await tools.exec_command({cmd: 'cat ~/.agent-secrets/.env'})",
      },
    }),
    {},
  );
});

test("Hook fails closed for malformed JSON and unsupported shell payloads", () => {
  const malformed = runGuard("{bad json", true);
  assert.equal(malformed.hookSpecificOutput.permissionDecision, "deny");

  const unsupported = runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "exec_command",
    tool_input: { script: "echo ok" },
  });
  assert.equal(unsupported.hookSpecificOutput.permissionDecision, "deny");
});

test("BLOCK rule errors fail closed while WARN rule errors stay advisory", () => {
  const block = {
    id: "test-block",
    action: "block" as const,
    test: () => {
      throw new Error("fixture");
    },
    message: () => "unused",
  };
  const warn = {
    id: "test-warn",
    action: "warn" as const,
    test: () => {
      throw new Error("fixture");
    },
    message: () => "unused",
  };
  matches(evaluateCommand("echo ok", [block]).blocks[0], /test-block/);
  assert.deepEqual(evaluateCommand("echo ok", [warn]), {
    blocks: [],
    warns: [],
  });
});

test("a BLOCK rule error names the cause and says the command was not checked", () => {
  const block = {
    id: "test-block",
    action: "block" as const,
    test: () => {
      throw new Error("fixture cause");
    },
    message: () => "unused",
  };
  const [reason] = evaluateCommand("echo ok", [block]).blocks;
  matches(reason, /rule error \(fixture cause\)/);
  matches(reason, /could not be checked, so it is blocked/);
});

const HOME = "C:\\Users\\demo";
const typedDecision = (tool: string, toolInput: Record<string, unknown>) =>
  runGuard({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: toolInput,
  }).hookSpecificOutput?.permissionDecision ?? "allow";
const typedGrep = (searchPath: string) =>
  typedDecision("Grep", { pattern: "H1-secrets-bash", path: searchPath });

test("typed Grep may search hook, settings and skill files under a harness root", () => {
  assert.equal(typedGrep(`${HOME}\\.claude\\hooks`), "allow");
  assert.equal(typedGrep(`${HOME}\\.claude\\settings.json`), "allow");
  assert.equal(typedGrep("~/.claude/skills/html-report/SKILL.md"), "allow");
  assert.equal(
    typedGrep(`${HOME}\\.claude\\projects\\C--Users-demo-repo\\0a1b2c3d.jsonl`),
    "allow",
  );
  assert.equal(
    typedGrep(
      `${HOME}\\.claude\\projects\\C--Users-demo-repo\\0a1b2c3d\\tool-results\\out.txt`,
    ),
    "allow",
  );
  assert.equal(typedGrep("~/.codex/config.toml"), "allow");
});

test("typed Grep still blocks the whole harness root and its secret and history items", () => {
  assert.equal(typedGrep(`${HOME}\\.claude`), "deny");
  assert.equal(typedGrep(`${HOME}\\.claude\\`), "deny");
  assert.equal(typedGrep("~/.claude/*"), "deny");
  assert.equal(typedGrep("~/.claude/*.jsonl"), "deny");
  assert.equal(typedGrep("~/.claude/hooks/.."), "deny");
  assert.equal(typedGrep("~/.claude/history.jsonl"), "deny");
  assert.equal(typedGrep("~/.claude/.credentials.json"), "deny");
  assert.equal(typedGrep("~/.codex"), "deny");
  assert.equal(typedGrep("~/.codex/sessions"), "deny");
  assert.equal(typedGrep("~/.codex/auth.json"), "deny");
  assert.equal(typedGrep("~/.config/opencode"), "deny");
  assert.equal(typedGrep("~/.agent-secrets"), "deny");
  assert.equal(typedGrep("~/.agent-secrets/.env"), "deny");
  assert.equal(typedGrep("/work/app/.env"), "deny");
  assert.equal(typedGrep("/home/demo/.ssh/id_rsa"), "deny");
  assert.equal(typedGrep("/work/keys/server.pem"), "deny");
  assert.equal(
    typedDecision("Grep", {
      pattern: "x",
      path: "src",
      paths: ["~/.agent-secrets/.env"],
    }),
    "deny",
  );
});

test("H1 allows a transcript search whose pattern holds quotes and backslashes", () => {
  const h1 = byId("H1-secrets-bash");
  const transcript = `${HOME}\\.claude\\projects\\C--Users-demo-repo\\0a1b2c3d.jsonl`;
  assert.equal(
    h1(`Select-String -Path "${transcript}" -Pattern 'dvb exec[^"\\\\]{0,60}'`),
    null,
  );
  assert.equal(
    h1(
      `Select-String -Path "${transcript}" -Pattern 'dvb exec[^"\\\\]{0,60}' -AllMatches | Select-Object -Last 3`,
    ),
    null,
  );
  assert.equal(
    h1(
      `grep -o 'tool_name' "${HOME.replace(/\\/g, "/")}/.claude/projects/C--Users-demo-repo/0a1b2c3d.jsonl" | sort | uniq -c`,
    ),
    null,
  );
});

test("H1 allows reading hook, settings and skill files under a harness root", () => {
  const h1 = byId("H1-secrets-bash");
  assert.equal(h1("grep -rn token ~/.claude/hooks"), null);
  assert.equal(
    h1(
      `Select-String -Path "${HOME}\\.claude\\settings.json" -Pattern 'PreToolUse|guard'`,
    ),
    null,
  );
  assert.equal(h1("rg -n PreToolUse ~/.claude/settings.json"), null);
  assert.equal(h1("cat ~/.claude/hooks/guard-bash.js"), null);
});

test("H1 still blocks searches of secret files, history and the whole harness root", () => {
  const h1 = byId("H1-secrets-bash");
  assert.ok(h1("grep KEY ~/.agent-secrets/.env"));
  assert.ok(h1("grep -r KEY ~/.agent-secrets"));
  assert.ok(h1("rg KEY /work/app/.env"));
  assert.ok(
    h1(`Select-String -Path "${HOME}\\.agent-secrets\\.env" -Pattern KEY`),
  );
  assert.ok(h1("Select-String -Path /work/app/.env -Pattern KEY"));
  assert.ok(h1("Select-String -Path /work/app/.env.production -Pattern KEY"));
  assert.ok(
    h1(`Select-String -Path "${HOME}\\.claude\\history.jsonl" -Pattern x`),
  );
  assert.ok(h1("grep -r x ~/.claude"));
  assert.ok(h1("grep -r x ~/.claude/"));
  assert.ok(h1("/usr/bin/grep -r x ~/.claude"));
  assert.ok(h1(" grep -r x ~/.claude"));
  assert.ok(h1("\t/usr/bin/grep -r x ~/.claude"));
  assert.ok(h1("/opt/tools/rg x ~/.claude/*"));
  assert.equal(h1("/usr/bin/grep -rn token ~/.claude/hooks"), null);
  assert.ok(h1("rg x ~/.claude/*"));
  assert.ok(h1("grep x ~/.codex/sessions/2026/rollout-a.jsonl"));
  assert.ok(h1("findstr KEY C:\\Users\\demo\\.zoho\\credentials"));
  assert.ok(h1("cat ~/.ssh/id_rsa"));
  assert.ok(h1("cat /work/keys/server.pem"));
  assert.ok(h1("head -c 40 ~/.ssh/id_ed25519"));
  assert.ok(h1("Get-Content C:\\Users\\demo\\.zoho\\credentials"));
  assert.ok(h1("printenv"));
  assert.ok(h1("printenv | sort"));
  assert.ok(h1("echo $GITHUB_TOKEN"));
  assert.ok(h1("echo ${AWS_SECRET_ACCESS_KEY}"));
  assert.ok(h1("Write-Host $OPENAI_API_KEY"));
});

test("H1 allows searches whose pattern only names token or credential", () => {
  const h1 = byId("H1-secrets-bash");
  assert.equal(h1("grep -i token src/"), null);
  assert.equal(h1('grep -rni "credential" src/'), null);
  assert.equal(h1('rg -n "api_token|secret" src'), null);
  assert.equal(
    h1('Select-String -Path src/auth.ts -Pattern "token|credential"'),
    null,
  );
  assert.equal(
    h1('tail -20 app.log | grep -viE "token|credential|pair"'),
    null,
  );
  assert.equal(
    typedDecision("Grep", { pattern: "token", path: "src" }),
    "allow",
  );
  assert.equal(
    typedDecision("Grep", {
      pattern: "credential|secret",
      path: "/work/app/src",
    }),
    "allow",
  );
});

test("H1 allows ss, a serve log tail, a wslconfig read and a dev tcp probe", () => {
  const h1 = byId("H1-secrets-bash");
  assert.equal(h1("ss -ltnp"), null);
  assert.equal(h1("ss -ltn | grep 3773"), null);
  assert.equal(h1("tail -n 50 /home/demo/.t3/serve.log"), null);
  assert.equal(
    h1(
      'tail -5 /home/demo/.t3/serve.log | cut -c1-200 | grep -viE "token|credential|pair"',
    ),
    null,
  );
  assert.equal(h1("cat ~/.wslconfig"), null);
  assert.equal(
    h1(
      `Get-Content "$env:USERPROFILE\\.wslconfig" -ErrorAction SilentlyContinue | Select-String 'network|localhost' | % Line`,
    ),
    null,
  );
  assert.equal(
    h1(
      "timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/3793' && echo OK || echo FAIL",
    ),
    null,
  );
  assert.equal(
    h1(
      `wsl -d Ubuntu -u root -- bash -c "timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/3793' && echo WSL-OK || echo WSL-FAIL; ss -ltn | grep 3793"; Get-Content "$env:USERPROFILE\\.wslconfig" -ErrorAction SilentlyContinue | Select-String 'network|localhost' | % Line`,
    ),
    null,
  );
  assert.equal(
    h1('wsl -d Ubuntu -u root -- bash -c "ss -ltn | grep 3793"'),
    null,
  );
});

test("H1 does not throw on PowerShell strings with backtick-n and unbalanced quotes", () => {
  const h1 = byId("H1-secrets-bash");
  const probe =
    "(Test-NetConnection 127.0.0.1 -Port 3773).TcpTestSucceeded\n$s=\"true`npgrep -af 't3 serve' | cut -c1-120`nss -ltn | grep 3773`ntail -5 /home/demo/.t3/serve.log | cut -c1-200 | grep -viE 'token|credential|pair'`n\"; $s | wsl -d Ubuntu -u root -- /root/.local/bin/dvb exec --project demo --target demo --timeout 60";
  assert.equal(h1(probe), null);
  assert.equal(
    h1("grep -c refs x.txt\nwsl bash <<EOF\necho it's done\nhead -1 a.md\nEOF"),
    null,
  );
  assert.equal(evaluateCommand(probe).blocks.length, 0);
});

test("H1 allows a bundle listing next to a WSL heredoc that runs head and tail on a markdown file", () => {
  const h1 = byId("H1-secrets-bash");
  const bundle = "E:\\reviews\\run-2026-11-16\\layer-4-final.bundle";
  assert.equal(
    h1(
      `git bundle list-heads ${bundle}\n$s = "true\`nhead -1 /home/demo/briefs/review.md; tail -2 /home/demo/briefs/review.md; grep -c . /home/demo/briefs/review.md\`n"`,
    ),
    null,
  );
  assert.equal(
    h1(
      `git bundle list-heads ${bundle}\nwsl -d Ubuntu -- bash -s <<'EOF'\nhead -1 /home/demo/briefs/review.md\ntail -2 /home/demo/briefs/review.md\nEOF`,
    ),
    null,
  );
  assert.equal(
    h1(
      `git bundle list-heads ${bundle} | Select-String main\nwsl bash <<'EOF'\necho "don't"\nhead -1 a.md\nEOF`,
    ),
    null,
  );
});

test("H1 treats a newline as a command boundary so later lines are still checked", () => {
  const h1 = byId("H1-secrets-bash");
  assert.ok(h1("echo start\ncat ~/.agent-secrets/.env"));
  assert.ok(h1("echo start\r\ncat ~/.agent-secrets/.env\r\necho end"));
  assert.ok(h1("echo start\ngrep KEY ~/.agent-secrets/.env"));
  assert.ok(h1("echo start\nenv"));
  assert.ok(h1("echo start\nprintenv\nls"));
  assert.ok(h1('echo start\nGet-Content "C:\\tmp\\prod.env"'));
  assert.equal(h1("echo start\nenv FOO=1 node script.js"), null);
  assert.equal(h1("echo start\ncat README.md\ngrep -n token README.md"), null);
});

test("H1 keeps checking a search whose quotes do not balance", () => {
  const h1 = byId("H1-secrets-bash");
  assert.ok(h1('grep "unclosed ~/.agent-secrets/.env'));
  assert.ok(h1("grep it's ~/.agent-secrets/.env"));
  assert.ok(
    h1(
      "Select-String -Path 'C:\\Users\\demo\\.claude\\history.jsonl -Pattern x",
    ),
  );
  assert.equal(h1("grep it's src/"), null);
});

test("Hook shows the reason and allows the five reported harmless calls", () => {
  const decision = (tool: string, toolInput: Record<string, unknown>) =>
    typedDecision(tool, toolInput);
  assert.equal(
    decision("Grep", {
      pattern: "H1-secrets-bash",
      path: `${HOME}\\.claude\\hooks`,
      output_mode: "files_with_matches",
    }),
    "allow",
  );
  assert.equal(
    decision("Grep", {
      pattern: "PreToolUse|guard",
      path: `${HOME}\\.claude\\settings.json`,
      output_mode: "content",
      "-C": 3,
    }),
    "allow",
  );
  assert.equal(
    decision("PowerShell", {
      command: `Select-String -Path "${HOME}\\.claude\\projects\\C--Users-demo-repo\\0a1b2c3d.jsonl" -Pattern 'dvb exec[^"\\\\]{0,60}' -AllMatches | Select-Object -Last 3`,
    }),
    "allow",
  );
  assert.equal(
    decision("PowerShell", {
      command:
        'git bundle list-heads E:\\reviews\\x.bundle\n$s = "true`nhead -1 /home/demo/a.md; tail -2 /home/demo/a.md; grep -c . /home/demo/a.md`n"',
    }),
    "allow",
  );
  assert.equal(
    decision("Bash", {
      command:
        "ss -ltnp; tail -5 /home/demo/.t3/serve.log; cat ~/.wslconfig; grep -i token src/",
    }),
    "allow",
  );
  const denied = runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "grep KEY ~/.agent-secrets/.env" },
  });
  matches(
    denied.hookSpecificOutput.permissionDecisionReason,
    /\[H1-secrets-bash\] BLOCKED — raw credential search/,
  );
});

test("H7 blocks hook bypasses", () => {
  const h7 = byId("H7-hook-bypass");
  assert.ok(h7("git commit --no-verify -m x"));
  assert.ok(h7(hookBypassCommand));
  assert.equal(h7("git commit -m fix"), null);
});

test("H8 blocks database drops and force-pushes to protected branches", () => {
  const h8 = byId("H8-live-destructive");
  assert.ok(h8('psql $DEV_URL -c "DROP DATABASE analytics"'));
  assert.ok(h8("git push --force origin main"));
  assert.equal(h8("git push origin feature-x"), null);
});

test("H8 checks database, branch and live-system commands in multiline inputs", () => {
  const destructive = [
    ['psql $DEV_URL -c "DROP DATABASE fixture"', /DROP DATABASE/],
    ["git push --force origin main", /force-push/],
    ["curl -X POST https://n8n-prod.example.test/webhook/x", /live system/],
  ] as const;
  for (const lineBreak of ["\n", "\r", "\r\n"]) {
    for (const [command, reason] of destructive) {
      const guard = runGuard({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: ["echo ready", `  ${command}  `, "echo done"].join(
            lineBreak,
          ),
        },
      });
      assert.equal(guard.hookSpecificOutput?.permissionDecision, "deny");
      matches(guard.hookSpecificOutput?.permissionDecisionReason, reason);
    }
    assert.deepEqual(
      runGuard({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: ["echo ready", "git push origin feature-x"].join(lineBreak),
        },
      }),
      {},
    );
  }
});

test("WARN rules coach without blocking", () => {
  const warn = (id: string) => byId(id);
  assert.ok(warn("H5-worktree")("git worktree add ../wt feature"));
  assert.equal(warn("H5-worktree")("forge worktree create feat"), null);
  assert.ok(warn(retiredRuleId)(retiredTrackerCommand));
  assert.equal(warn(retiredRuleId)("forge ready"), null);
  assert.ok(warn("H12-cd-chain")("cd /tmp && ls"));
  assert.equal(warn("H12-cd-chain")("ls /tmp"), null);
});

test("H8 blocks live-system writes but never reads", () => {
  const h8 = byId("H8-live-destructive");
  assert.ok(
    h8("curl -X POST https://n8n-prod.example.com/webhook/x -d @payload.json"),
  );
  assert.ok(h8('psql $NEON_PROD_URL -c "DELETE FROM leads"'));
  assert.ok(
    h8("curl -X PATCH https://graph.microsoft.com/curapod-workbook -d @body"),
  );

  assert.equal(h8("curl https://n8n-prod.example.com/api/workflows"), null);
  assert.equal(h8('psql $DEV_URL -c "SELECT * FROM leads"'), null);
  assert.equal(h8('psql $DEV_URL -c "DELETE FROM scratch"'), null);

  assert.equal(h8("rm /e/curapod/CLAUDE.md"), null);
  assert.equal(
    h8(
      'Remove-Item E:\\curapod\\CLAUDE.md; rm "E:/curapod/curapod/.worktrees/x/tmp.txt"',
    ),
    null,
  );
  assert.equal(h8("mv ~/Downloads/curapod/a.md ./curapod-notes/a.md"), null);

  assert.ok(
    h8("rm /e/curapod/x && curl -X DELETE https://curapodm.com/wp-json/x"),
  );
  assert.equal(h8("echo act_170153044"), null);
});

const BLOCKED_POWERSHELL_ENV = [
  "echo $env:N8N_API_KEY",
  "Write-Output $env:GITHUB_TOKEN",
  "Write-Host $env:DB_PASSWORD",
  'Write-Host "token: $($env:MY_SECRET)"',
  "echo ${env:API_KEY}",
  "echo $env:api_key",
  "$env:API_KEY",
  "$env:api_key",
  "${env:API_KEY}",
  '"$env:API_KEY"',
  '"key is $env:PATH and $env:API_KEY"',
  "($env:API_KEY)",
  "$env:API_KEY | Set-Clipboard",
  "$env:API_KEY.Substring(0,4)",
  "$env:A = 1\n$env:API_KEY",
  "Get-Item env:API_KEY",
  "Get-ChildItem env:GITHUB_TOKEN",
  "dir env:SERVICE_SECRET",
  String.raw`gci Env:\MY_PASSWORD`,
  "gci -Path env:API_KEY",
  "gi env:API_KEY",
  "Get-ChildItem env:*KEY*",
  "Get-Content env:API_KEY",
  "Get-ChildItem env:API_KEY | Select-Object Name,Value",
  "Get-ChildItem env:",
  "Get-ChildItem Env:",
  "gci env:",
  "dir env:",
  "ls env:",
  "gci env:" + "\\",
  "gci env:*",
  "Get-ChildItem env: | Format-Table -AutoSize",
  "Get-ChildItem env: | Out-File out.txt",
  "Get-ChildItem env: | Select-Object Name,Value",
  "Get-ChildItem env: | Where-Object Name -match KEY",
  powerShellCommand('"gci env:"'),
  "[Environment]::GetEnvironmentVariable('API_KEY')",
  "[System.Environment]::GetEnvironmentVariable(\"GITHUB_TOKEN\", 'User')",
  "Write-Host ([Environment]::GetEnvironmentVariable('MY_SECRET'))",
  "echo start\n[Environment]::GetEnvironmentVariable('API_KEY')",
];

const ALLOWED_POWERSHELL_ENV = [
  "$env:API_KEY = 'x'",
  '$env:API_KEY="x"',
  "$env:API_KEY += 'x'",
  "$env:A = 1; $env:API_KEY = 'x'",
  "$env:PATH",
  "echo $env:PATH",
  "Write-Host $env:USERPROFILE",
  String.raw`Write-Output "$env:USERPROFILE\src"`,
  "node app.js --key $env:API_KEY",
  "if ($env:API_KEY) { node run.js }",
  "if (-not $env:API_KEY) { node run.js }",
  '$body = @"\nplain text\n"@; $env:GH_TOKEN = gh auth token; gh issue create --title "x y" --body $body',
  "Get-Item env:PATH",
  "gci env:PATH",
  "[Environment]::GetEnvironmentVariable('PATH')",
  "$v = [Environment]::GetEnvironmentVariable('API_KEY')",
  "[Environment]::SetEnvironmentVariable('API_KEY','x','User')",
  String.raw`Get-ChildItem C:\src`,
  "ls src",
  "dir",
];

test("H1 blocks printing a secret-named environment variable in PowerShell forms", () => {
  const h1 = byId("H1-secrets-bash");
  for (const command of BLOCKED_POWERSHELL_ENV) assert.ok(h1(command), command);
});

test("H1 allows setting and passing PowerShell environment variables and listing non-secret names", () => {
  const h1 = byId("H1-secrets-bash");
  for (const command of ALLOWED_POWERSHELL_ENV)
    assert.equal(h1(command), null, command);
});

test("PowerShell env blocks reach the hook through the hook with a reason", () => {
  const denied = runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "PowerShell",
    tool_input: { command: "Write-Output $env:N8N_API_KEY" },
  });
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  matches(
    denied.hookSpecificOutput.permissionDecisionReason,
    /\[H1-secrets-bash\] BLOCKED — credential variable output/,
  );
  const bare = runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "PowerShell",
    tool_input: { command: "Get-ChildItem env:" },
  });
  matches(bare.hookSpecificOutput.permissionDecisionReason, /bare env dump/);
  const namesOnly = runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "PowerShell",
    tool_input: { command: "Get-ChildItem env: | Select-Object Name" },
  });
  assert.equal(namesOnly.hookSpecificOutput.permissionDecision, "deny");
  matches(
    namesOnly.hookSpecificOutput.permissionDecisionReason,
    /bare env dump/,
  );
});

const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);

test("round 2 fix 1: H1 joins backslash and backtick line continuations before looking for commands", () => {
  const h1 = byId("H1-secrets-bash");
  const bs = `${BACKSLASH}\n`;
  const bt = `${BACKTICK}\n`;
  assert.ok(h1(`cat ${bs}~/.agent-secrets/.env`));
  assert.ok(h1(`cat ${BACKSLASH}\r\n~/.agent-secrets/.env`));
  assert.ok(h1(`ca${bs}t ~/.agent-secrets/.env`));
  assert.ok(h1(`head -n 3 ${bs}  /work/app/.env`));
  assert.ok(h1(`grep KEY ${bs}  ~/.agent-secrets/.env`));
  assert.ok(h1(`rg -n KEY ${bs}~/.agent-secrets`));
  assert.ok(h1(`Get-Content ${bt}~/.agent-secrets/.env`));
  assert.ok(h1(`Select-String -Pattern KEY ${bt}-Path ~/.agent-secrets/.env`));
  assert.ok(h1(`echo ${bs}$GITHUB_TOKEN`));
  assert.ok(h1(`Write-Output ${bt}$env:API_KEY`));
  assert.equal(h1(`cat README.md ${bs}  src/file.txt`), null);
  assert.equal(h1(`grep -n token ${bs}  src/`), null);
  assert.equal(h1(`git log ${bs}--oneline`), null);
  assert.equal(h1(`Get-ChildItem C:${BACKSLASH}src${bt}-Recurse`), null);
});

test("round 2 fix 2: path checks resolve dot segments, slashes, case, short names and drive forms", () => {
  const win = (rest: string) =>
    `${HOME}${BACKSLASH}${rest.split("/").join(BACKSLASH)}`;
  const blockedTyped = [
    "C:/Users/FIXTUR~1/.claude/.",
    "~/.claude/.",
    "~/.claude/./",
    "~/.claude//",
    "~/.CLAUDE/.",
    "$HOME/.claude/././",
    "${HOME}/.claude/.",
    "~/.claude/hooks/../.",
    "~/.claude/hooks/../..",
    "/mnt/c/Users/demo/.claude/.",
    "/c/Users/demo/.claude/hooks/..",
    "~/.claude.",
    "~/.codex/.",
    "~/.agent-secrets/.",
    "C:/Users/FIXTUR~1/CLAUDE~1",
    "C:/Users/FIXTUR~1/CLAUDE~1/history.jsonl",
    "C:/Users/FIXTUR~1/CODEX~1/sessions",
    "C:/Users/FIXTUR~1/AGENT-~1/ENV~1",
    win(".claude/."),
    `${win(".claude")}${BACKSLASH}.${BACKSLASH}`,
    win(".claude/./history.jsonl"),
  ];
  for (const searchPath of blockedTyped)
    assert.equal(typedGrep(searchPath), "deny", searchPath);
  const allowedTyped = [
    "~/.claude/hooks/.",
    "~/.claude/./hooks",
    "/mnt/c/Users/demo/.claude/hooks",
    "C:/Users/FIXTUR~1/.claude/skills",
    "C:/Users/FIXTUR~1/CLAUDE~1/hooks",
    win(".claude/hooks/."),
  ];
  for (const searchPath of allowedTyped)
    assert.equal(typedGrep(searchPath), "allow", searchPath);
  assert.equal(
    typedDecision("Read", { file_path: "~/.claude/./history.jsonl" }),
    "deny",
  );
  assert.equal(
    typedDecision("Read", { file_path: "~/.claude/hooks/../history.jsonl" }),
    "deny",
  );
  assert.equal(
    typedDecision("Read", { file_path: "~/.claude/hooks/../settings.json" }),
    "allow",
  );
});

test("round 2 fix 2: shell searches and reads resolve the same path forms", () => {
  const h1 = byId("H1-secrets-bash");
  assert.ok(h1("rg --hidden . ~/.claude/."));
  assert.ok(h1("grep -r x ~/.claude/."));
  assert.ok(h1('grep -r x "$HOME/.claude/./"'));
  assert.ok(h1("rg x /mnt/c/Users/demo/.claude/."));
  assert.ok(h1("rg x C:/Users/FIXTUR~1/CLAUDE~1"));
  assert.ok(
    h1(
      `Select-String -Path "${HOME}${BACKSLASH}.claude${BACKSLASH}." -Pattern .`,
    ),
  );
  assert.ok(h1("cat ~/.claude/./history.jsonl"));
  assert.ok(h1("cat ~/.claude/hooks/../history.jsonl"));
  assert.ok(h1("cat C:/Users/demo/CLAUDE~1/history.jsonl"));
  assert.ok(
    h1(
      `Get-Content ${HOME}${BACKSLASH}.claude${BACKSLASH}.${BACKSLASH}history.jsonl`,
    ),
  );
  assert.ok(h1("cat /work/app/ENV~1"));
  assert.equal(h1("rg x ~/.claude/hooks/."), null);
  assert.equal(h1("grep -rn token ~/.claude/./hooks"), null);
  assert.equal(h1("cat ~/.claude/hooks/../settings.json"), null);
});

test("round 2 fix 3: flag-value forms and unbalanced quotes never hide a protected path", () => {
  const h1 = byId("H1-secrets-bash");
  const reviewerCase = `Select-String -Path:$HOME/.agent-secrets/.env -Pattern ".|${BACKTICK}""`;
  assert.ok(h1(reviewerCase));
  assert.ok(h1("Select-String -Path:$HOME/.agent-secrets/.env -Pattern x"));
  assert.ok(h1("Select-String -LiteralPath=~/.agent-secrets/.env -Pattern x"));
  assert.ok(h1("Select-String -Path:/work/app/.env x"));
  assert.ok(h1("rg --file=~/.agent-secrets/.env x"));
  assert.ok(
    h1(
      `Select-String -Path=C:${BACKSLASH}Users${BACKSLASH}demo${BACKSLASH}.claude${BACKSLASH}history.jsonl -Pattern "unclosed`,
    ),
  );
  assert.ok(h1('grep --file=~/.agent-secrets/.env "unclosed'));
  assert.ok(h1('grep -f~/.agent-secrets/.env "unclosed'));
  assert.ok(h1('rg -f ~/.agent-secrets/.env "unclosed'));
  assert.ok(h1('Select-String -Path:/work/app/.env -Pattern "unclosed'));
  assert.ok(h1('Select-String -LiteralPath:~/.claude/. -Pattern "unclosed'));
  assert.equal(h1("Select-String -Pattern:foo -Path:src/a.txt x"), null);
  assert.equal(
    h1('Select-String -Pattern:foo -Path:src/a.txt "unclosed'),
    null,
  );
  assert.equal(h1('grep -n "unclosed src/'), null);
  assert.equal(
    h1(`grep -viE 'token|credential|pair'${BACKTICK}n"; $s | wsl -d Ubuntu`),
    null,
  );
});

test("round 2 fix 3: an unbalanced search whose path cannot be classified is blocked with its own reason", () => {
  const h1 = byId("H1-secrets-bash");
  assert.equal(
    h1('Select-String -Path:$(Get-SecretPath) -Pattern "unclosed'),
    "unclassifiable search arguments (unbalanced quotes)",
  );
  assert.equal(
    h1(`Select-String -Path ${BACKTICK}$p -Pattern "unclosed`),
    "unclassifiable search arguments (unbalanced quotes)",
  );
  assert.equal(
    h1('grep -f $(echo x) "unclosed'),
    "unclassifiable search arguments (unbalanced quotes)",
  );
  assert.equal(
    h1('grep --file=$(echo x) "unclosed'),
    "unclassifiable search arguments (unbalanced quotes)",
  );
  const [reason] = evaluateCommand(
    'Select-String -Path:$(Get-SecretPath) -Pattern "unclosed',
  ).blocks;
  matches(
    reason,
    /\[H1-secrets-bash\] BLOCKED — unclassifiable search arguments/,
  );
});

test("simplified: every env: drive listing blocks, with or without a name projection", () => {
  const h1 = byId("H1-secrets-bash");
  const blocked = [
    "Get-ChildItem env: | ForEach-Object { $_.Name; $_ }",
    "gci env: | ForEach-Object { $_.Name; $_.Value }",
    "gci env: | % { $_ ; $_.Name }",
    "gci env: | ForEach-Object { $_.Name; Write-Host $_ }",
    "gci env: | ForEach-Object { Write-Host $_ }",
    'gci env: | ForEach-Object { "$_" }',
    "gci env: | ForEach-Object { $_.Name + $_ }",
    "gci env: | Select-Object Name, *",
    "gci env: | Select-Object -Property *",
    "gci env: | Select-Object Name,Value",
    "gci env: | Sort-Object Name",
    "gci env: | Select-Object -First 5",
    "gci env: | Where-Object Name -match KEY",
    "gci env: | Where-Object { $_.Name -like 'A*' } | ForEach-Object { $_.Name; $_ }",
    "gci env: | ForEach-Object { $_ } | Select-Object Name",
    "Get-Item env:API_KEY | ForEach-Object { $_.Name; $_ }",
    "(gci env:)",
    "(gci env:).Value",
    "(gci env:).Name.Value",
    "gci env: | Format-List Name",
    "gci env: | Out-String",
  ];
  for (const command of blocked) assert.ok(h1(command), command);
  const formerlyAllowed = [
    "Get-ChildItem env: | Select-Object Name",
    "Get-ChildItem env: | Select-Object -ExpandProperty Name",
    "Get-ChildItem env: | Select-Object -Property Name",
    "gci env: -Name",
    "(gci env:).Name",
    "(Get-ChildItem env:).Name | Sort-Object",
    "gci env: | ForEach-Object Name",
    "gci env: | % Name",
    "gci env: | ForEach-Object -MemberName Name",
    "gci env: | ForEach-Object { $_.Name }",
    "gci env: | ForEach-Object { $PSItem.Name }",
    "gci env: | % { $_.Name; }",
    "gci env: | Where-Object Name -match '^T3' | Select-Object Name",
    "gci env: | Where-Object { $_.Name -match '^(T3|CLAUDE)' } | ForEach-Object Name",
    "gci env: | Sort-Object Name | Select-Object -ExpandProperty Name",
    "gci env: | Select-Object -ExpandProperty Name | Sort-Object",
    "gci env: | ForEach-Object { $_.Name } | Out-String",
    "(gci env: | Select-Object Name)",
    "Get-ChildItem Env: | Where-Object { $_.Name -match '^(T3|CLAUDE)' } | ForEach-Object Name",
    "Get-ChildItem env: -Name:$false",
    "gci env: -Name:$false",
    "gci env: -Name:$true",
  ];
  for (const command of formerlyAllowed) assert.ok(h1(command), command);
});

test("simplified: filter and sort script blocks that print before a name projection block", () => {
  const h1 = byId("H1-secrets-bash");
  const payloads = [
    "gci env: | Where-Object { $_ | oh; $true } | Select-Object Name",
    "gci env: | Sort-Object { [Console]::WriteLine($_.get_Value()); $_.Name } | Select-Object Name",
  ];
  for (const command of payloads) assert.ok(h1(command), command);
});

test("simplified: a quoted closing parenthesis in an env listing finishes fast and blocks", () => {
  const command =
    "gci env: | Where-Object { $_.Name -match '[)]' } | Select-Object Name";
  const result = timedRule(command);
  assert.ok(result.ms < 4000);
  assert.equal(result.result, "bare env dump");
  const harmless =
    "Get-ChildItem src | Where-Object { $_.Name -match '[)]' } | Select-Object Name";
  assert.equal(byId("H1-secrets-bash")(harmless), null);
});

test("simplified: single-quoted PowerShell env references block like every other print form", () => {
  const h1 = byId("H1-secrets-bash");
  const formerlyAllowed = [
    "Write-Output '$env:API_KEY'",
    "Write-Host '$env:API_KEY'",
    "echo '${env:API_KEY}'",
    "Write-Host -ForegroundColor Red '$env:API_KEY'",
    "Write-Output 'it''s $env:API_KEY'",
    "Write-Output '$env:API_KEY'; Write-Output ok",
    "Write-Output 'set $env:GITHUB_TOKEN first'\nWrite-Output ok",
  ];
  for (const command of formerlyAllowed) assert.ok(h1(command), command);
  const blocked = [
    'Write-Output "$env:API_KEY"',
    "Write-Output $env:API_KEY",
    "Write-Output '$env:API_KEY' $env:API_KEY",
    "Write-Output '$env:API_KEY' \"$env:API_KEY\"",
    "Write-Output \"x '$env:API_KEY' y\"",
    'Write-Output "a;b"; Write-Output "x \'$env:API_KEY\'"',
    "Write-Output \"x;echo '$env:API_KEY'\"",
    "Write-Output '$env:API_KEY' | iex",
    "Write-Output '$env:API_KEY' | Invoke-Expression",
    `Write-Output '$env:API_KEY' | ${powerShellCommand("-")}`,
    powerShellCommand("'Write-Output $env:API_KEY'"),
    "pwsh -c 'echo $env:API_KEY'",
    "Write-Output '$env:API_KEY' \"unclosed",
    "echo '$GITHUB_TOKEN'",
    "bash -c 'echo $GITHUB_TOKEN'",
  ];
  for (const command of blocked) assert.ok(h1(command), command);
});

test("simplified: no single-quote exemption exists for any print, pipe or call form", () => {
  const h1 = byId("H1-secrets-bash");
  const blocked = [
    "Write-Output '$env:API_KEY' | & $runner",
    "Write-Output '$env:API_KEY' | python -c \"import sys; exec(sys.stdin.read())\"",
    "Write-Output '$env:API_KEY' | Out-File run.ps1",
    "Write-Output '$env:API_KEY' | ForEach-Object { iex $_ }",
    "Write-Output ('$env:API_KEY' | iex)",
    "Write-Output $ExecutionContext.InvokeCommand.ExpandString('$env:API_KEY')",
    "Write-Output ('$env:API_KEY').Replace('x','y')",
    "Write-Output '$env:API_KEY' > out.ps1",
    "Write-Output $x '$env:API_KEY'",
    "Write-Output @('$env:API_KEY')",
    "Write-Output '$env:API_KEY' & iex",
  ];
  for (const command of blocked) assert.ok(h1(command), command);
  const nested = [
    'Write-Output "$(iex " \'$env:API_KEY\' ")"',
    "Write-Output \"$(iex \" '$env:API_KEY' \")\" 'x'",
    "Write-Output \"a\" '$env:API_KEY'",
    "Write-Output '$env:API_KEY' \"a\"",
    "Write-Output \"a\"'$env:API_KEY'",
    "Write-Output '$env:API_KEY'x",
    "Write-Output x'$env:API_KEY'",
    "Write-Output '$env:API_KEY''$env:API_KEY'x",
    'echo "$(bash -c " \'$env:API_KEY\' ")"',
  ];
  for (const command of nested) assert.ok(h1(command), command);
  assert.ok(h1("Write-Output 'a' '$env:API_KEY' 'b'"));
  assert.ok(h1("Write-Host -NoNewline -ForegroundColor Green '$env:API_KEY'"));
});

test("backstop: a read, search or print verb anywhere plus a protected path anywhere blocks, however the lines split", () => {
  const h1 = byId("H1-secrets-bash");
  const blocked = [];
  for (const eol of ["\n", "\r\n"]) {
    blocked.push(
      `Get-Content @(${eol}'~/.agent-secrets/.env'${eol})`,
      `Get-Content (${eol}'~/.agent-secrets/.env'${eol})`,
      `Get-Content -Path (${eol}"$HOME/.agent-secrets/.env"${eol})`,
      `Get-Content $(${eol}'/work/app/.env'${eol})`,
      `Get-Content @(${eol}'/tmp/prod.env'${eol})`,
      `Get-Content @('notes.txt',${eol}'~/.ssh/id_rsa')`,
      `Get-Content @(${eol}'${HOME}${BACKSLASH}.claude${BACKSLASH}history.jsonl'${eol})`,
      `Get-Content @(${eol}'C:/Users/FIXTUR~1/AGENT-~1/ENV~1'${eol})`,
      `Select-String -Pattern x -Path @(${eol}'~/.agent-secrets/.env'${eol})`,
      `grep KEY (${eol}~/.agent-secrets/.env${eol})`,
      `cat <(${eol}echo x${eol}) ~/.agent-secrets/.env`,
      `Get-Content @(${eol}'/work/keys/server.pem'${eol})`,
    );
  }
  blocked.push(
    ". ~/.agent-secrets/.env; cat ~/.agent-secrets/.env",
    'head -n 2 notes.txt; echo done; cat "$HOME/.agent-secrets/.env"',
    "sed -n 1,5p ~/.agent-secrets/.env",
    "base64 /work/app/.env.production",
    "tail -f ~/.codex/auth.json",
  );
  for (const command of blocked)
    assert.ok(h1(command), JSON.stringify(command));
  const allowed = [
    "set -a; . ~/.agent-secrets/.env; set +a; node run.js | head -5",
    "source ~/.agent-secrets/.env && cat README.md",
    ". ~/.agent-secrets/.env; grep -n x src/a.txt",
    "echo A=1 >> ~/.agent-secrets/.env; cat README.md",
    "cat README.md > ~/.agent-secrets/out.txt",
    "Get-Content @(\n'~/.claude/hooks/guard-bash.js'\n)",
    "Get-Content @(\r\n'.env.example'\r\n)",
    "cat ~/.claude/hooks/guard-bash.js ~/.claude/settings.json",
    "grep -rn token ~/.claude/hooks src/",
    "tail -n 30 /home/demo/.t3/serve.log; cat ~/.wslconfig",
  ];
  for (const command of allowed)
    assert.equal(h1(command), null, JSON.stringify(command));
});

function timedGuardRun(command: string) {
  const started = performance.now();
  const decision = runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
  return { elapsed: performance.now() - started, decision };
}

test("bounds: backslash-heavy unclosed quotes finish fast and keep blocking secret reads", () => {
  const heavy = BACKSLASH.repeat(60);
  const harmless = timedGuardRun(`cat "${heavy}x`);
  assert.ok(harmless.elapsed < 5000, `took ${harmless.elapsed} ms`);
  const secret = timedGuardRun(`cat "${heavy}x ~/.agent-secrets/.env`);
  assert.ok(secret.elapsed < 5000, `took ${secret.elapsed} ms`);
  assert.equal(secret.decision.hookSpecificOutput?.permissionDecision, "deny");
  const single = timedGuardRun(`grep '${heavy}x ~/.agent-secrets/.env`);
  assert.ok(single.elapsed < 5000, `took ${single.elapsed} ms`);
  assert.equal(single.decision.hookSpecificOutput?.permissionDecision, "deny");
});

test("bounds: repeated unclosed braced env openers finish fast", () => {
  const dollar = String.fromCharCode(36);
  const shapes = [
    `echo ${(dollar + "{KEY").repeat(19000)}`,
    `echo ${(dollar + "{env:KEY").repeat(11000)}`,
    `"${(dollar + "{env:KEY").repeat(11000)}`,
    `echo ${(dollar + "KEY").repeat(24000)}`,
  ];
  for (const command of shapes) {
    const run = timedGuardRun(command);
    assert.ok(
      run.elapsed < 5000,
      `took ${run.elapsed} ms for ${command.length} characters`,
    );
  }
});

test("bounds: a command over the length cap blocks with a length reason", () => {
  assert.equal(typeof MAX_COMMAND_LENGTH, "number");
  const h1 = byId("H1-secrets-bash");
  matches(h1(`echo ${"a".repeat(MAX_COMMAND_LENGTH)}`), /too long/);
  assert.equal(h1(`echo ${"a".repeat(MAX_COMMAND_LENGTH - 10)}`), null);
});

test("bounds: makeBound throws a clear error once the iteration budget is spent", () => {
  const tick = makeBound(3);
  tick();
  tick();
  tick();
  assert.throws(tick, /analysis bound exceeded/);
  const { blocks } = evaluateCommand("x", [
    {
      id: "H1-secrets-bash",
      action: "block" as const,
      test: () => {
        const t = makeBound(0);
        t();
        return null;
      },
      message: () => "",
    },
  ]);
  matches(blocks[0], /analysis bound exceeded.*blocked/);
});

test("env references: braced names, drive prefixes and the whole-environment .NET call block", () => {
  const h1 = byId("H1-secrets-bash");
  const blocked = [
    "Write-Output ${env:MY-API-KEY}",
    'Write-Host "${env:GH-TOKEN}"',
    "${env:OPENAI-API-KEY}",
    "Get-ChildItem -Path:env:",
    "gci -Path:env:API_KEY",
    "Get-Item -Path:env:GH_TOKEN",
    "[Environment]::GetEnvironmentVariables()",
    "[System.Environment]::GetEnvironmentVariables() | Out-String",
  ];
  for (const command of blocked) assert.ok(h1(command), command);
  assert.equal(h1("Set-Item -Path:env:FOO -Value 1"), null);
  assert.equal(h1('$env:PATH = "$env:PATH;C:\\tools"'), null);
});

function timedRule(command: string) {
  const started = performance.now();
  const result = byId("H1-secrets-bash")(command);
  return { ms: performance.now() - started, result };
}

test("round 2 finding 1: braced names longer than the scan bound block as unclassifiable", () => {
  const h1 = byId("H1-secrets-bash");
  const open = "$" + "{";
  const long = "A".repeat(129);
  const blocked = [
    `echo ${open}${long}KEY}`,
    `echo ${open}KEY${long}}`,
    `Write-Output ${open}env:${long}KEY}`,
    `Write-Output ${open}env:KEY${long}}`,
    `${open}env:${long}TOKEN}`,
    `printf %s ${open}${"B".repeat(400)}SECRET${"C".repeat(400)}}`,
    `echo ${open}${"A".repeat(128)}KEY}`,
  ];
  for (const command of blocked) assert.ok(h1(command), command.slice(0, 60));
  assert.equal(h1(`echo ${open}${long}}`), null);
  assert.equal(h1(`echo ${open}HOME:-${long}}`), null);
});

test("round 2 finding 2: shell quote joining cannot hide a verb or a path", () => {
  const h1 = byId("H1-secrets-bash");
  const blocked = [
    "c''at ~/.agent-secrets/.env",
    "sed -n p ~/.agent-''secrets/.''env",
    'c""at \\\n~/.agent-secrets/.env',
    'c""at ~/.agent-secrets/.env',
    "ca't' ~/.agent-secrets/.env",
    "Get-Content ~/.agent-'secrets'/.env",
    "head -n 1 ~/.agent-secrets/'.e'nv",
    "grep x ~/.ag''ent-secrets/.env",
    "c\\at ~/.agent-secrets/.env",
    "sed -n p\n~/.agent-''secrets/.''env",
  ];
  for (const command of blocked)
    assert.ok(h1(command), JSON.stringify(command));
  const allowed = [
    "cat 'README.md'",
    'echo "hello world"',
    "grep -n 'token' src/a.js",
    "git commit -m 'fix the thing'",
  ];
  for (const command of allowed) assert.equal(h1(command), null, command);
});

test("round 2 finding 3: read-write and input redirections are never output targets", () => {
  const h1 = byId("H1-secrets-bash");
  const blocked = [
    "cat <> ~/.agent-secrets/.env",
    "sed -n p 0<> ~/.agent-secrets/.env",
    "cat 3<> ~/.agent-secrets/.env",
    "sed -n p <>~/.agent-secrets/.env",
    "cat <~/.agent-secrets/.env",
    "sed -n p < ~/.agent-secrets/.env",
  ];
  for (const command of blocked) assert.ok(h1(command), command);
  assert.equal(h1("cat README.md > ~/.agent-secrets/out.txt"), null);
  assert.equal(h1("cat README.md 2>> ~/.agent-secrets/err.log"), null);
});

test("round 2 finding 4: carve-outs never hide a command substitution", () => {
  const h1 = byId("H1-secrets-bash");
  const blocked = [
    '{ source "$(sed -n p ~/.agent-secrets/.env >&3)"; } 3>&1',
    '{ : > "$(sed -n p ~/.agent-secrets/.env >&3)"; } 3>&1',
    'source "$(sed -n p ~/.agent-secrets/.env)"',
    "source <(cat ~/.agent-secrets/.env)",
    ". $(sed -n p ~/.agent-secrets/.env)",
    'echo x > "$(cat ~/.agent-secrets/.env)"',
    `: > "${BACKTICK}sed -n p ~/.agent-secrets/.env${BACKTICK}"`,
    `source ${BACKTICK}cat ~/.agent-secrets/.env${BACKTICK}`,
    "echo x >> $(head ~/.agent-secrets/.env)",
  ];
  for (const command of blocked) assert.ok(h1(command), command);
  const allowed = [
    "source ~/.agent-secrets/.env",
    'set -a; . "$HOME/.agent-secrets/.env"; set +a; node run.js',
    "echo done > ~/.agent-secrets/out.txt",
  ];
  for (const command of allowed) assert.equal(h1(command), null, command);
});

test("round 2 review: a redirect or source operator inside quotes cannot hide a real path", () => {
  const h1 = byId("H1-secrets-bash");
  const blocked = [
    'sed -n p "a > " ~/.agent-secrets/.env "b"',
    "cat 'x >' ~/.agent-secrets/.env 'y'",
    'echo "x; . " ~/.agent-secrets/.env " y"',
    "head -n 1 'a 2>' ~/.agent-secrets/.env 'b'",
    'cat "q >>" ~/.agent-secrets/.env "r"',
    'sed -n p "a >\n" ~/.agent-secrets/.env "b"',
  ];
  for (const command of blocked)
    assert.ok(h1(command), JSON.stringify(command));
  assert.equal(h1("cat README.md > ~/.agent-secrets/out.txt"), null);
  assert.equal(h1("source ~/.agent-secrets/.env"), null);
  assert.equal(h1('cat README.md > "~/.agent-secrets/out.txt"'), null);
});

test("round 2 finding 5: relative env filenames stay protected inside multiline reads", () => {
  const h1 = byId("H1-secrets-bash");
  const names = [
    "prod.env",
    "deployment.env.production",
    ".env.local",
    "staging.env",
    "app.env.development",
  ];
  const blocked = [];
  for (const eol of ["\n", "\r\n"]) {
    for (const name of names) {
      blocked.push(
        `Get-Content @(${eol}'${name}'${eol})`,
        `Get-Content (${eol}"${name}"${eol})`,
        `Get-Content @('notes.txt',${eol}'${name}')`,
      );
    }
  }
  blocked.push('Select-String -Pattern x -Path @(\n"prod.env"\n)');
  for (const command of blocked)
    assert.ok(h1(command), JSON.stringify(command));
  assert.equal(h1("Get-Content @(\n'.env.example'\n)"), null);
  assert.equal(h1("Get-Content @(\n'README.md'\n)"), null);
});

test("round 2 finding 6: redirection scanning is linear on long digit runs", () => {
  const room = MAX_COMMAND_LENGTH - 40;
  const secret = timedRule(
    "cat " + "1".repeat(room) + " ~/.agent-secrets/.env",
  );
  assert.ok(secret.ms < 1000, `${secret.ms} ms`);
  assert.ok(secret.result);
  const cat = timedRule("cat " + "1".repeat(room));
  assert.ok(cat.ms < 1000, `${cat.ms} ms`);
  assert.equal(cat.result, null);
  const sed = timedRule("sed " + "1".repeat(room));
  assert.ok(sed.ms < 1000, `${sed.ms} ms`);
  assert.equal(sed.result, null);
  const redirect = timedRule("cat README.md " + "2".repeat(room) + "> x");
  assert.ok(redirect.ms < 1000, `${redirect.ms} ms`);
  const spread = timedRule("cat x " + "1 >".repeat(Math.floor(room / 3)));
  assert.ok(spread.ms < 1000, `${spread.ms} ms`);
});

test("bounds: each worst-case payload family just under the length cap finishes in under a second", () => {
  const limit = MAX_COMMAND_LENGTH - 1;
  const pair = String.fromCharCode(92, 34);
  const path = " ~/.agent-secrets/.env";
  const families = [
    [
      "sed with escaped-quote pairs",
      `sed ${pair.repeat(Math.floor((limit - 4) / 2))}`,
      false,
    ],
    [
      "awk with escaped-quote pairs and a protected path",
      `awk ${pair.repeat(Math.floor((limit - 4 - path.length) / 2))}${path}`,
      true,
    ],
    [
      "cat with a digit run and a protected path",
      `cat ${"1".repeat(limit - 4 - path.length)}${path}`,
      true,
    ],
    ["sed with a digit run", `sed ${"1".repeat(limit - 4)}`, false],
    [
      "awk with a digit run and a protected path",
      `awk ${"2".repeat(limit - 4 - path.length)}${path}`,
      true,
    ],
    [
      "repeated unclosed braced openers",
      `echo ${("$" + "{KEY").repeat(Math.floor((limit - 5) / 5))}`,
      null,
    ],
    [
      "repeated unclosed braced env openers",
      `echo ${("$" + "{env:KEY").repeat(Math.floor((limit - 5) / 9))}`,
      null,
    ],
  ] as const;
  for (const [name, command, blocks] of families) {
    assert.ok(command.length <= limit, name);
    const run = timedRule(command);
    assert.ok(run.ms < 1000, `${name}: ${run.ms} ms`);
    if (blocks === true) assert.ok(run.result, name);
    if (blocks === false) assert.equal(run.result, null, name);
  }
});

test("bounds: the review payload over the cap blocks at once with the length reason", () => {
  const pair = String.fromCharCode(92, 34);
  const run = timedRule(`sed ${pair.repeat(30000)}`);
  matches(run.result, /too long/);
  assert.ok(run.ms < 300, `${run.ms} ms`);
});

test("round 2 finding 7: 8.3 short names that could abbreviate a protected name are protected", () => {
  const h1 = byId("H1-secrets-bash");
  const blocked = [
    "Get-Content C:/Users/demo/ZOHO~1/CREDEN~1",
    "Get-Content @(\n'C:/Users/demo/ZOHO~1/CREDEN~1'\n)",
    "Get-Content C:/work/app/ENVPRO~1",
    "cat C:/work/app/ENV~1",
    "cat C:/work/app/ENV~1.PRO",
    "type C:\\work\\app\\CREDEN~1.ENV",
    "cat C:/Users/demo/AGENT-~1/ENV~1",
    "cat C:/Users/demo/AGENT~2/ENV~1",
    "cat C:/Users/demo/.ssh/ID_ED~1",
    "grep x C:/work/app/CREDEN~2",
  ];
  for (const command of blocked) assert.ok(h1(command), command);
  const allowed = [
    "Get-Content C:/Users/FIXTUR~1/notes.txt",
    "cat C:/PROGRA~1/app/readme.txt",
    "cat C:/Users/FIXTUR~1/DOCUME~1/a.txt",
  ];
  for (const command of allowed) assert.equal(h1(command), null, command);
});

test("the key-name listing block says plainly that no names helper exists yet", () => {
  const { blocks } = evaluateCommand("cut -d= -f1 ~/.agent-secrets/.env");
  matches(
    blocks[0],
    /key-name listing of a secret file is blocked and has no helper yet/,
  );
  doesNotMatch(blocks[0], /names/);
  assert.equal(
    byId("H1-secrets-bash")(
      "forge safe-inspect metadata ~/.agent-secrets/.env",
    ),
    null,
  );
});

test("round 2 finding 8: any env drive listing with a wildcard blocks", () => {
  const h1 = byId("H1-secrets-bash");
  const blocked = [
    "gci env:[A-Z]*",
    "gci env:*?",
    "Get-ChildItem env:API_KE?",
    "Get-ChildItem 'env:[A-Z]*'",
    "dir env:A*",
    "Get-Item env:*PI*",
    "ls env:?",
  ];
  for (const command of blocked) assert.ok(h1(command), command);
  assert.equal(h1("Set-Item env:FOO -Value 1"), null);
});
