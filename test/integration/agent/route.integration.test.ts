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
const root = mkdtempSync(join(tmpdir(), "forge-route-"));
const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
const node = Bun.which("node")!;
// Copy only OS/process essentials: inherited harness variables must not choose the result.
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(name),
  ),
);
env.FORGE_DEVICE_ROOT = join(root, "device");
function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(node, [bin, ...args], {
    cwd: root,
    env: { ...env, ...extra },
    encoding: "utf8",
    windowsHide: true,
    timeout: 45_000,
  });
}
beforeAll(() => {
  writeFileSync(
    join(root, "package.json"),
    '{"name":"route-fixture","scripts":{"test":"node --version"}}',
  );
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, ".forge/config.yaml"),
    '{"schemaVersion":"forge.config/1","blocks":{}}',
  );
  const show = JSON.parse(run(["config", "show"]).stdout) as {
    result: { revision: string };
  };
  const imported = run([
    "template",
    "import",
    "delivery",
    "--expect-revision",
    show.result.revision,
  ]);
  expect(imported.stdout).toContain('"ok":true');
  expect(imported.status).toBe(0);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("imported delivery detects Claude without admission or persisted adapter config", () => {
  const result = run(["route", "get", "build", "--text"], { CLAUDECODE: "1" });
  expect(result.stdout).toContain(
    "line: current high standard claude single-family",
  );
  expect(result.status).toBe(0);
  expect(readFileSync(join(root, ".forge/config.yaml"), "utf8")).not.toContain(
    "adapters",
  );
});
test("no detect variable uses current", () => {
  const result = run(["route", "get", "build", "--text"]);
  expect(result.stdout).toContain(
    "line: current high standard current single-family",
  );
  expect(result.status).toBe(0);
});
test("nested harness variables use current instead of guessing the innermost harness", () => {
  const result = run(["route", "get", "build", "--text"], {
    CLAUDECODE: "1",
    CODEX_THREAD_ID: "test",
  });
  expect(result.stdout).toContain(
    "line: current high standard current single-family",
  );
  expect(result.status).toBe(0);
});
test("the shipped Codex adapter detects only its exact variable", () => {
  const result = run(["route", "get", "build", "--text"], {
    CODEX_THREAD_ID: "test",
  });
  expect(result.stdout).toContain(
    "line: current high standard codex single-family",
  );
  expect(result.status).toBe(0);
  const companion = run(["route", "get", "build", "--text"], {
    CODEX_COMPANION_SESSION_ID: "test",
  });
  expect(companion.stdout).toContain(
    "line: current high standard current single-family",
  );
  expect(companion.status).toBe(0);
});
test("environment names follow the host platform's casing rules", () => {
  const result = run(["route", "get", "build", "--text"], { claudecode: "1" });
  const harness = process.platform === "win32" ? "claude" : "current";
  expect(result.stdout).toContain(
    `line: current high standard ${harness} single-family`,
  );
  expect(result.status).toBe(0);
});
test("explicit project adapters replace the derived list", () => {
  const config = join(root, ".forge/config.yaml");
  const original = readFileSync(config, "utf8");
  try {
    const show = JSON.parse(run(["config", "show"]).stdout) as {
      result: { revision: string };
    };
    const set = run([
      "config",
      "set",
      "--input",
      JSON.stringify({
        path: "agent.adapters",
        value: [],
        expectRevision: show.result.revision,
      }),
    ]);
    expect(set.stdout).toContain('"ok":true');
    expect(set.status).toBe(0);
    const result = run(["route", "get", "build", "--text"], {
      CLAUDECODE: "1",
      CODEX_THREAD_ID: "test",
    });
    expect(result.stdout).toContain(
      "line: current high standard current single-family",
    );
    expect(result.status).toBe(0);
  } finally {
    writeFileSync(config, original);
  }
});
test("a renamed forge/agent instance still detects the harness", () => {
  const config = join(root, ".forge/config.yaml");
  const original = readFileSync(config, "utf8");
  try {
    const show = JSON.parse(run(["config", "show"]).stdout) as {
      result: { revision: string };
    };
    const changed = run([
      "config",
      "apply",
      "--input",
      JSON.stringify({
        expectRevision: show.result.revision,
        patch: [
          { op: "remove", path: "/blocks/agent" },
          {
            op: "set",
            path: "/blocks/router",
            value: { source: { builtin: "forge/agent" } },
          },
        ],
      }),
    ]);
    expect(changed.stdout).toContain('"ok":true');
    expect(changed.status).toBe(0);
    const result = run(["route", "get", "build", "--text"], {
      CLAUDECODE: "1",
    });
    expect(result.stdout).toContain(
      "line: current high standard claude single-family",
    );
    expect(result.status).toBe(0);
  } finally {
    writeFileSync(config, original);
  }
});
test("unknown role lists all allowed roles with INPUT_INVALID", () => {
  const result = run(["route", "get", "deploy"]);
  expect(result.stdout).toContain("INPUT_INVALID");
  for (const role of [
    "intake",
    "plan",
    "cut",
    "build",
    "review",
    "land",
    "learn",
    "rate",
    "merge",
    "judge",
    "verify",
  ])
    expect(result.stdout).toContain(role);
  expect(result.status).toBe(6);
});
test("max names the routing file with INPUT_INVALID", () => {
  const result = run(["route", "get", "build", "--max"]);
  expect(result.stdout).toContain("~/.forge/routing.yaml");
  expect(result.stdout).toContain("INPUT_INVALID");
  expect(result.status).toBe(6);
});
