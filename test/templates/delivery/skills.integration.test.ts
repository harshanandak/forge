import { describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GENERATED_MARKER } from "../../../src/surface/skills.ts";
import { yamlConfigCodec } from "../../../src/adapters/config-yaml/index.ts";
import { DEFAULT_PARSE_LIMITS } from "../../../src/contract/untrusted.ts";

const branchBin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");

function fixture(
  run: (
    root: string,
    cli: (args: string[], bin?: string) => SpawnSyncReturns<string>,
  ) => void,
  importBin = branchBin,
) {
  const root = mkdtempSync(join(tmpdir(), "forge-agent-skills-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(
        name,
      ),
    ),
  );
  env.FORGE_DEVICE_ROOT = join(root, "device");
  const cli = (args: string[], bin = branchBin) =>
    spawnSync(Bun.which("node")!, [bin, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 45_000,
    });
  try {
    writeFileSync(
      join(root, "package.json"),
      '{"name":"skills-fixture","scripts":{"test":"node --version"}}',
    );
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      '{"schemaVersion":"forge.config/1","blocks":{}}',
    );
    const shown = cli(["config", "show"], importBin);
    expect(shown.status, shown.stdout).toBe(0);
    const revision = (
      JSON.parse(shown.stdout) as { result: { revision: string } }
    ).result.revision;
    const imported = cli(
      ["template", "import", "delivery", "--expect-revision", revision],
      importBin,
    );
    expect(imported.status, imported.stdout).toBe(0);
    run(root, cli);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const adapterDirs = [".claude/skills", ".agents/skills"];
function hashes(root: string) {
  return readdirSync(root, { recursive: true })
    .filter((file) => lstatSync(join(root, String(file))).isFile())
    .map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(root, String(file))))
        .digest("hex"),
    ]);
}

test("built sync manages marked skills and companions in both adapter directories", () => {
  fixture((root, cli) => {
    const sync = () => cli(["skills", "sync"]);
    const check = () => cli(["skills", "sync", "--check"]);
    const first = sync();
    expect(first.status, first.stdout).toBe(0);
    const original = new Map<string, string>();
    for (const dir of adapterDirs) {
      const skill = join(root, dir, "forge-loop/SKILL.md");
      const text = readFileSync(skill, "utf8");
      expect(text).toContain(
        `${GENERATED_MARKER}\n<!-- forge companions: agents/openai.yaml -->`,
      );
      expect(
        readFileSync(join(root, dir, "forge-loop/agents/openai.yaml"), "utf8"),
      ).toBe("policy:\n  allow_implicit_invocation: false\n");
      original.set(skill, text);
      writeFileSync(join(root, dir, "forge-loop/NOTES.md"), "user notes\n");
      writeFileSync(skill, text.replace(/\n/g, "\r\n"));
    }
    const crlf = hashes(root);
    expect(check().status).toBe(0);
    expect(sync().status).toBe(0);
    expect(hashes(root)).toEqual(crlf);
    const target = join(root, adapterDirs[0]!, "forge-loop/SKILL.md");
    writeFileSync(target, `${original.get(target)}edited\n`);
    const before = hashes(root);
    const drift = check();
    expect(drift.status).toBe(1);
    expect(drift.stdout).toContain(".claude/skills/forge-loop/SKILL.md");
    expect(drift.stdout).toContain(
      "run forge skills sync; it overwrites edits to generated files",
    );
    expect(hashes(root)).toEqual(before);
    expect(sync().status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(original.get(target)!);
    rmSync(target);
    expect(sync().status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(original.get(target)!);
    for (const dir of adapterDirs) {
      expect(readFileSync(join(root, dir, "forge-loop/NOTES.md"), "utf8")).toBe(
        "user notes\n",
      );
      expect(existsSync(join(root, dir, "forge-loop/agents/openai.yaml"))).toBe(
        true,
      );
    }
    const unmarked = join(root, adapterDirs[0]!, "forge-loop");
    writeFileSync(join(unmarked, "SKILL.md"), "# mine\n");
    writeFileSync(join(unmarked, "agents/openai.yaml"), "mine: true\n");
    expect(sync().status).toBe(0);
    expect(readFileSync(join(unmarked, "SKILL.md"), "utf8")).toBe("# mine\n");
    expect(readFileSync(join(unmarked, "agents/openai.yaml"), "utf8")).toBe(
      "mine: true\n",
    );
    const skipped = check();
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain(
      "left alone because Forge did not write them:",
    );
  });
}, 180_000);

test("built sync rejects adapter escapes without mutating the outside directory", () => {
  fixture((root, cli) => {
    expect(cli(["skills", "sync"]).status).toBe(0);
    const skill = join(root, ".agents/skills/forge-loop/SKILL.md");
    const original = readFileSync(skill, "utf8");
    const outsideSkill = join(root, "outside-skill");
    mkdirSync(outsideSkill);
    writeFileSync(join(outsideSkill, "x"), "untouched\n");
    symlinkSync(
      outsideSkill,
      join(root, ".agents/skills/forge-loop/link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const path of ["../x", "SKILL.md", "agents\\openai.yaml", "link/x"]) {
      const edited = original.replace(
        "<!-- forge companions: agents/openai.yaml -->",
        `<!-- forge companions: ${path} -->`,
      );
      writeFileSync(skill, edited);
      const before = hashes(root);
      const refused = cli(["skills", "sync"]);
      expect(refused.status, refused.stdout).toBe(6);
      expect(hashes(root)).toEqual(before);
      expect(readFileSync(join(outsideSkill, "x"), "utf8")).toBe("untouched\n");
    }
    writeFileSync(skill, original);
    const path = join(root, ".forge/config.yaml");
    const decoded = yamlConfigCodec.decode(
      readFileSync(path, "utf8"),
      DEFAULT_PARSE_LIMITS,
    );
    if (!decoded.ok) throw new Error(decoded.error.message);
    const config = decoded.value as { blocks: { agent: { config?: object } } };
    const setAdapters = (adapters: object[]) => {
      config.blocks.agent.config = { adapters };
      writeFileSync(path, JSON.stringify(config));
    };
    for (const skills of ["../x", root]) {
      setAdapters([{ id: "bad", detect: [], skills }]);
      const refused = cli(["skills", "sync"]);
      expect(refused.status, refused.stdout).toBe(6);
      expect(refused.stdout).toContain("refusing");
    }
    setAdapters([{ id: "bad", detect: [], surprise: true }]);
    expect(cli(["skills", "sync"]).status).toBe(6);
    const outside = mkdtempSync(join(tmpdir(), "forge-skills-outside-"));
    try {
      writeFileSync(join(outside, "NOTES.md"), "untouched\n");
      symlinkSync(
        outside,
        join(root, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
      setAdapters([{ id: "bad", detect: [], skills: "escape/skills" }]);
      expect(cli(["skills", "sync"]).status).toBe(6);
      expect(readdirSync(outside)).toEqual(["NOTES.md"]);
      expect(readFileSync(join(outside, "NOTES.md"), "utf8")).toBe(
        "untouched\n",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
}, 120_000);

const upgradeBin = process.env.FORGE_SKILLS_UPGRADE_BIN;
describe.skipIf(!upgradeBin)("upgrade from main", () => {
  test("built sync retires main's slice skill and keeps user notes", () => {
    fixture((root, cli) => {
      expect(cli(["skills", "sync"], upgradeBin).status).toBe(0);
      for (const dir of adapterDirs) {
        expect(
          readFileSync(join(root, dir, "slice/SKILL.md"), "utf8"),
        ).toContain(GENERATED_MARKER);
        writeFileSync(join(root, dir, "slice/NOTES.md"), "keep me\n");
      }
      expect(cli(["skills", "sync", "--check"]).status).toBe(1);
      expect(cli(["skills", "sync"]).status).toBe(0);
      for (const dir of adapterDirs) {
        expect(existsSync(join(root, dir, "slice/SKILL.md"))).toBe(false);
        expect(readFileSync(join(root, dir, "slice/NOTES.md"), "utf8")).toBe(
          "keep me\n",
        );
        const cut = readFileSync(join(root, dir, "forge-cut/SKILL.md"), "utf8");
        for (const rule of [
          "400 changed lines",
          "above 800",
          "deletions exceed twice the additions",
          "churn over 518 lines +2",
          "over 10 files +2",
          "`core` or `blocks` +1",
          "light 0-1",
          "standard 2-3",
          "heavy 4-5",
          "forge companions: framing.md",
        ])
          expect(cut).toContain(rule);
        expect(existsSync(join(root, dir, "forge-cut/framing.md"))).toBe(true);
        const intake = readFileSync(
          join(root, dir, "forge-intake/SKILL.md"),
          "utf8",
        );
        for (const rule of [
          "one session",
          "300 lines",
          "prototype/<name>",
          "verdict",
          "comment on the intent issue",
        ])
          expect(intake).toContain(rule);
      }
      expect(cli(["skills", "sync", "--check"]).status).toBe(0);
    }, upgradeBin);
  }, 120_000);
});

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
        /^ {2}agent:\r?\n {4}source:\r?\n {6}builtin: forge\/agent\r?\n/m,
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
