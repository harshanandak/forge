import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packedConsumer } from "../../integration/packed-consumer.ts";

const canary = "fixture-registered-credential-only";
const packageRoot = join(packedConsumer(), "node_modules", "forge-workflow");
const cli = join(packageRoot, "dist", "bin", "forge.js");
const launcher = join(packageRoot, "templates", "guard", "run.mjs");
const profile = join(packageRoot, "templates", "guard");
const dangerous = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "cat ~/.agent-secrets/.env" },
};
const post = {
  hook_event_name: "PostToolUse",
  tool_response: { output: canary },
};

function fixture(
  action: (
    root: string,
    run: (args: string[], input?: string, cwd?: string) => string,
  ) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "forge-guard-fixture-"));
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  const env = {
    HOME: root,
    USERPROFILE: root,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: root,
    TMP: root,
    PATH: "",
    FORGE_DEVICE_ROOT: join(root, "device"),
  };
  try {
    const secrets = join(root, ".agent-secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, ".env"), `FIXTURE_API_TOKEN=${canary}\n`);
    action(root, (args, input, cwd = root) => {
      const child = spawnSync(node, args, {
        cwd,
        env,
        input,
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(
        child.stdout.includes(canary) || child.stderr.includes(canary),
      ).toBe(false);
      expect(child.stderr).toBe("");
      return child.stdout;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("installed Forge dispatches hook JSON and safe inspection from the shipped guard profile", () => {
  fixture((root, run) => {
    const invoke = (op: string, input: object): unknown =>
      JSON.parse(run([cli, "--hook", op], JSON.stringify(input), profile));
    expect(invoke("guard.command", dangerous)).toMatchObject({
      ok: true,
      result: { hookSpecificOutput: { permissionDecision: "deny" } },
    });
    expect(invoke("guard.output", post)).toMatchObject({
      ok: true,
      result: { decision: "block" },
    });
    const largerOutput = {
      ...post,
      tool_response: "a".repeat(1024 * 1024 + 1),
    };
    expect(invoke("guard.output", largerOutput)).toMatchObject({
      ok: true,
      result: {},
    });
    const file = join(root, "fixture.json");
    const content = JSON.stringify({ accessToken: canary });
    writeFileSync(file, content);
    const inspect = (mode: string): unknown =>
      JSON.parse(run([cli, "safe-inspect", mode, file], undefined, profile));
    const metadata = {
      ok: true,
      bytes: Buffer.byteLength(content),
      modifiedAt: expect.any(String) as unknown,
      rawContentReturned: false,
    };
    expect(inspect("metadata")).toMatchObject({ ok: true, result: metadata });
    expect(inspect("summary")).toMatchObject({
      ok: true,
      result: { ...metadata, jsonValid: true, redactionMarkers: 1 },
    });
  });
}, 90_000);

test("harness launcher withholds blocked results and denies when Forge fails", () => {
  fixture((root, run) => {
    const check = (
      script: string,
      op: string,
      event: object | string,
    ): unknown =>
      JSON.parse(
        run(
          [script, op],
          typeof event === "string" ? event : JSON.stringify(event),
        ),
      );
    expect(check(launcher, "guard.command", dangerous)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(check(launcher, "guard.command", "{")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(check(launcher, "guard.output", post)).toMatchObject({
      decision: "block",
    });
    const batch = { hook_event_name: "PostToolBatch", tool_calls: [post] };
    expect(check(launcher, "guard.output", batch)).toMatchObject({
      decision: "block",
    });
    expect(
      check(launcher, "guard.output", {
        ...batch,
        tool_calls: [{ tool_response: "fixture benign" }],
      }),
    ).toEqual({});
    const fakeRegistry = join(root, ".agent-secrets", ".env");
    writeFileSync(fakeRegistry, "fixture malformed registry\n");
    expect(
      check(launcher, "guard.output", {
        ...post,
        tool_response: "fixture benign",
      }),
    ).toMatchObject({ decision: "block" });

    const broken = join(root, "templates", "guard");
    mkdirSync(broken, { recursive: true });
    const brokenLauncher = join(broken, "run.mjs");
    copyFileSync(launcher, brokenLauncher);
    expect(check(brokenLauncher, "guard.command", dangerous)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const fakeBin = join(root, "dist", "bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, "forge.js"),
      `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: false, error: { code: "UNAVAILABLE", message: canary } }))}); process.exitCode = 1;`,
    );
    expect(check(brokenLauncher, "guard.command", dangerous)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(check(brokenLauncher, "guard.output", post)).toMatchObject({
      decision: "block",
    });
  });
}, 120_000);
