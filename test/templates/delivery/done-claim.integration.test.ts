import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(60_000);
const repo = resolve(import.meta.dirname, "../../..");
const root = mkdtempSync(join(tmpdir(), "forge-done-claim-"));
const project = join(root, "project");
const monorepo = join(root, "monorepo");
const nestedProject = join(monorepo, "packages/app");
const bin = join(repo, "dist/bin/forge.js");
const script = join(
  repo,
  "templates/delivery/skills/forge-build/done-claim.mjs",
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(key),
  ),
);
env.FORGE_DEVICE_ROOT = join(root, "device");
const node = Bun.which("node")!;
function run(exe: string, args: string[], cwd = project, input?: string) {
  return spawnSync(exe, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 45_000,
    ...(input === undefined ? {} : { input }),
  });
}
function git(...args: string[]) {
  const result = run("git", args);
  expect(result.status).toBe(0);
  return result.stdout.trim();
}
function forge(...args: string[]) {
  const result = run(node, [bin, ...args]);
  expect(result.status).toBe(0);
  return (
    JSON.parse(result.stdout) as { result: { id: string; subject: string } }
  ).result;
}
let receipt: string;
let nestedReceipt: string;
beforeAll(() => {
  mkdirSync(join(project, ".forge"), { recursive: true });
  mkdirSync(join(project, "nested"));
  writeFileSync(
    join(project, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        check: {
          source: { builtin: "forge/check" },
          config: {
            commands: {
              proof: "node --version",
              fail: "node missing-proof.mjs",
            },
          },
        },
      },
    }),
  );
  git("init");
  git("add", ".forge/config.yaml");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const pass = forge(
    "check",
    "run",
    "--input",
    JSON.stringify({ checks: ["proof"] }),
  );
  expect(pass.subject).toBe(git("rev-parse", "HEAD"));
  receipt = pass.id;
  mkdirSync(join(nestedProject, ".forge"), { recursive: true });
  mkdirSync(join(nestedProject, "src"));
  writeFileSync(
    join(nestedProject, ".forge/config.yaml"),
    readFileSync(join(project, ".forge/config.yaml")),
  );
  for (const args of [
    ["init"],
    ["add", "."],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "nested fixture",
    ],
  ])
    expect(run("git", args, monorepo).status).toBe(0);
  const nestedPass = run(
    node,
    [bin, "check", "run", "--input", JSON.stringify({ checks: ["proof"] })],
    nestedProject,
  );
  expect(nestedPass.status).toBe(0);
  nestedReceipt = (JSON.parse(nestedPass.stdout) as { result: { id: string } })
    .result.id;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

for (const harness of ["claude", "codex"]) {
  function hook(message: string, active = false, cwd = project) {
    const input = {
      session_id: "fixture",
      cwd,
      transcript_path: null,
      hook_event_name: "Stop",
      permission_mode: "default",
      stop_hook_active: active,
      last_assistant_message: message,
      ...(harness === "codex"
        ? { model: "fixture", turn_id: "fixture" }
        : { background_tasks: [], session_crons: [] }),
    };
    return run(node, [script], root, JSON.stringify(input));
  }
  test(`${harness} Stop blocks a done claim without proof and never echoes message secrets`, () => {
    const result = hook("Done. private-canary-must-not-echo");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "block" });
    expect(result.stdout).toContain("Not covered");
    expect(result.stdout).toContain("Unverified:");
    expect(result.stdout + result.stderr).not.toContain("private-canary");
  });
  test(`${harness} Stop allows current PASS proof and requires not covered`, () => {
    expect(hook(`Verified: ${receipt}\nNot covered: live hooks`).stdout).toBe(
      "",
    );
    expect(hook(`Fixed: ${receipt}`).stdout).toContain('"block"');
  });
  test(`${harness} R1-2 reads a current receipt from the project root when stopped below it`, () => {
    const result = hook(
      `Done. ${receipt}\nNot covered: live hooks`,
      false,
      join(project, "nested"),
    );
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });
  test(`${harness} ignores fenced and inline code`, () => {
    for (const message of [
      "```text\nDone.\n```",
      "~~~text\nDone.\n~~~",
      "Example: `done`",
      "Example: ``Done.``",
      "> ~~~\n> Done.\n> ~~~",
      "    ~~~\n    Done.\n    ~~~",
      "````text\n```\nDone.\n```\n`````",
      "~~~~text\n~~~\nDone.\n~~~\n~~~~~",
    ]) {
      expect(hook(message).stdout).toBe("");
    }
  });
  test(`${harness} blocks prose between four-character fences`, () => {
    for (const fence of ["````", "~~~~"]) {
      const message = `${fence}text\nfirst\n${fence}\nDone.\n${fence}text\nsecond\n${fence}`;
      expect(hook(message).stdout, message).toContain('"block"');
    }
  });
  test.each([
    "Done.\n- ~~~\n  Unverified: tests not run\n  ~~~",
    "```language`oops\nDone.",
    "~~~\rcontent\r~~~\rDone.",
    "Done.\n``Unverified: tests not run``",
    "~~~text\nDone.",
    "````text\n```\nDone.",
    "````text\nDone.\n```",
    "~~~~text\nDone.\n~~~",
  ])(`${harness} preserves claims outside matched code: %s`, (message) => {
    const result = hook(message);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"block"');
  });
  test(`${harness} silently ignores null and non-object payloads`, () => {
    for (const input of ["null", "false", "0", '"text"', "[]"]) {
      const result = run(node, [script], root, input);
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toBe("");
    }
  });
  test.each([
    "Done.",
    "Fixed it.",
    "All checks are ready.",
    "Ready to start implementation.",
    "Tests not run; implementation is done.",
    "Done, any questions?",
    "Done but unverified",
  ])(`${harness} R2-1 blocks completion words: %s`, (message) => {
    expect(hook(message).stdout, message).toContain('"block"');
  });
  test(`${harness} R2-1 requires code-free proof and accepts decorated labels`, () => {
    expect(
      hook(`Done. ${receipt}\n~~~\nNot covered: live hooks\n~~~`).stdout,
    ).toContain('"block"');
    expect(
      hook("Done. `" + receipt + "`\nNot covered: live hooks").stdout,
    ).toContain('"block"');
    for (const label of [
      "**Not covered:**",
      "*Not covered*:",
      "- **Not covered:**",
      "* Not covered -",
    ]) {
      expect(hook(`Done. ${receipt}\n${label} live hooks`).stdout, label).toBe(
        "",
      );
    }
    for (const label of [
      "Unverified:",
      "**Unverified:**",
      "*Unverified*:",
      "- **Unverified:**",
      "* Unverified:",
    ]) {
      expect(hook(`Done.\n${label} tests not run`).stdout, label).toBe("");
    }
    expect(hook("Done.\n`Unverified:` tests not run").stdout).toContain(
      '"block"',
    );
  });
  test(`${harness} R2-1 considers only the first three code-free receipt ids`, () => {
    const ids = [1, 2, 3].map((n) => `00000000-0000-0000-0000-00000000000${n}`);
    expect(
      hook(`Done. ${ids.join(" ")} ${receipt}\nNot covered: live hooks`).stdout,
    ).toContain('"block"');
    expect(
      hook(
        `Done. ${ids.slice(0, 2).join(" ")} ${receipt} ${ids[2]}\nNot covered: live hooks`,
      ).stdout,
    ).toBe("");
  });
  test(`${harness} R1-3 accepts uppercase receipt ids and a Not covered dash`, () => {
    const result = hook(
      `Verified. ${receipt.toUpperCase()}\nNot covered - live hooks`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });
  test(`${harness} R1b-5 guards a nested Forge project and its subfolder`, () => {
    const proof = `Done. ${nestedReceipt}\nNot covered: live hooks`;
    for (const cwd of [nestedProject, join(nestedProject, "src")]) {
      expect(hook("Done.", false, cwd).stdout).toContain('"block"');
      expect(hook(proof, false, cwd).stdout).toBe("");
    }
    mkdirSync(join(monorepo, ".forge"), { recursive: true });
    const outer = join(monorepo, ".forge/config.yaml");
    writeFileSync(outer, '{"schemaVersion":"forge.config/1","blocks":{}}');
    try {
      expect(hook(proof, false, join(nestedProject, "src")).stdout).toBe("");
    } finally {
      rmSync(outer);
    }
  });
  test(`${harness} R2-2 stops at a native-canonical git boundary below a Forge folder`, () => {
    const outside = join(project, `non-forge-${harness}`);
    mkdirSync(outside);
    expect(run("git", ["init"], outside).status).toBe(0);
    const alias =
      process.platform === "win32"
        ? outside.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        : outside;
    const result = hook("Done.", false, alias);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });
  test(`${harness} Stop allows unverified, recursive invocation and non-project directories silently`, () => {
    for (const result of [
      hook("Done.\nUnverified: tests not run"),
      hook("Done", true),
      hook("Done", false, root),
      hook("Working"),
    ]) {
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toBe("");
    }
  });
}
test("Stop refuses a non-PASS receipt even when its subject is HEAD", () => {
  const failed = run(node, [
    bin,
    "check",
    "run",
    "--input",
    JSON.stringify({ checks: ["fail"] }),
  ]);
  expect(failed.status).toBe(1);
  const proof = (
    JSON.parse(failed.stdout) as { result: { id: string; status: string } }
  ).result;
  expect(proof.status).toBe("FAIL");
  const result = run(
    node,
    [script],
    root,
    JSON.stringify({
      cwd: project,
      last_assistant_message: `Fixed ${proof.id}\nNot covered: live hooks`,
    }),
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"block"');
});
test("a user-wide hook is silent in a git repository without Forge", () => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  expect(run("git", ["init"], outside).status).toBe(0);
  const result = run(
    node,
    [script],
    root,
    JSON.stringify({ cwd: outside, last_assistant_message: "Done" }),
  );
  expect(result.status).toBe(0);
  expect(result.stdout + result.stderr).toBe("");
});
test("Stop refuses an older commit receipt", () => {
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "new head",
  );
  const result = run(
    node,
    [script],
    root,
    JSON.stringify({
      cwd: project,
      last_assistant_message: `Ready for review. ${receipt}\nNot covered: live hooks`,
      stop_hook_active: false,
    }),
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"block"');
});
test("delivery skills leave watches armed across wakes", () => {
  for (const name of [
    "forge-build",
    "forge-review",
    "forge-land",
    "forge-loop",
  ]) {
    const text = readFileSync(
      join(repo, `templates/delivery/skills/${name}/SKILL.md`),
      "utf8",
    );
    if (name === "forge-review" || name === "forge-loop") {
      expect(text).toContain("After each push, run `forge agent wait <n>`");
      expect(text).toContain("`t3-tool`, skip its steps");
    }
    if (name === "forge-build")
      expect(text).not.toContain("forge agent wait <n>");
    if (name === "forge-loop")
      expect(text).toContain("Only when resuming a session");
    if (name === "forge-land") expect(text).toContain("--done");
    expect(text).not.toMatch(
      /watch_pull_request|gh pr checks .*--watch|Claude Code|Codex|T3 Code/,
    );
  }
});
