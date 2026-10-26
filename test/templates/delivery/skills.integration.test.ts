import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GENERATED_MARKER } from "../../../src/surface/skills.ts";

test("this repository's copied config syncs the current delivery skills", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-repo-skills-"));
  const repo = resolve(import.meta.dirname, "../../..");
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(
        name,
      ),
    ),
  );
  env.FORGE_DEVICE_ROOT = join(root, "device");
  try {
    mkdirSync(join(root, ".forge"));
    const config = readFileSync(join(repo, ".forge/config.yaml"), "utf8");
    const path = join(root, ".forge/config.yaml");
    writeFileSync(path, config);
    const sync = () =>
      spawnSync(
        Bun.which("node")!,
        [join(repo, "dist/bin/forge.js"), "skills", "sync"],
        {
          cwd: root,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 45_000,
        },
      );
    const synced = sync();
    expect(synced.stdout).toContain('"ok":true');
    expect(synced.status).toBe(0);
    for (const name of ["forge-loop", "forge-intake"])
      expect(existsSync(join(root, ".agents/skills", name, "SKILL.md"))).toBe(
        true,
      );
    writeFileSync(
      path,
      config.replace(
        /^  agent:\r?\n    source:\r?\n      builtin: forge\/agent\r?\n/m,
        "",
      ),
    );
    const missing = sync();
    expect(missing.status).toBe(1);
    for (const text of [
      "OUTPUT_INVALID",
      "route.get",
      "forge/agent",
      ".forge/config.yaml",
      "remove and re-import the template",
    ])
      expect(missing.stdout).toContain(text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("built delivery import syncs linted router and intake and retires generated loop", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-intake-"));
  const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(
        name,
      ),
    ),
  );
  env.FORGE_DEVICE_ROOT = join(root, "device");
  const run = (args: string[]) => {
    const result = spawnSync(Bun.which("node")!, [bin, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 45_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('"ok":true');
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as { result: Record<string, unknown> };
  };
  try {
    writeFileSync(
      join(root, "package.json"),
      '{"name":"intake-fixture","scripts":{"test":"node --version"}}',
    );
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      '{"schemaVersion":"forge.config/1","blocks":{}}',
    );
    const revision = run(["config", "show"]).result.revision;
    run([
      "template",
      "import",
      "delivery",
      "--expect-revision",
      String(revision),
    ]);
    const skills = join(root, ".agents/skills");
    mkdirSync(join(skills, "loop"), { recursive: true });
    writeFileSync(
      join(skills, "loop/SKILL.md"),
      `${GENERATED_MARKER}\nold loop`,
    );
    const synced = run(["skills", "sync"]);
    expect(synced.result.removed).toContain(".agents/skills/loop/SKILL.md");
    const names = readdirSync(skills).filter((name) =>
      existsSync(join(skills, name, "SKILL.md")),
    );
    expect(names).toContain("forge-loop");
    expect(names).toContain("forge-intake");
    expect(names).not.toContain("loop");
    const intake = readFileSync(join(skills, "forge-intake/SKILL.md"), "utf8");
    expect(intake).toContain("forge route get <role> --text");
    expect(intake).toContain("disable-model-invocation: false");
    expect(readFileSync(join(skills, "forge-loop/SKILL.md"), "utf8")).toContain(
      "disable-model-invocation: true",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
