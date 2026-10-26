import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GENERATED_MARKER } from "../../../src/surface/skills.ts";
import { yamlConfigCodec } from "../../../src/adapters/config-yaml/index.ts";
import { DEFAULT_PARSE_LIMITS } from "../../../src/contract/untrusted.ts";

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

test("built sync honors adapter dirs, companions, read-only checks and adapter refusals", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-agent-skills-"));
  const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(
        name,
      ),
    ),
  );
  env.FORGE_DEVICE_ROOT = join(root, "device");
  const run = (...args: string[]) =>
    spawnSync(Bun.which("node")!, [bin, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 45_000,
    });
  const configPath = join(root, ".forge/config.yaml");
  const dirs = [".claude/skills", ".agents/skills"];
  try {
    writeFileSync(
      join(root, "package.json"),
      '{"name":"skills-fixture","scripts":{"test":"node --version"}}',
    );
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
    mkdirSync(join(root, ".forge"));
    writeFileSync(configPath, '{"schemaVersion":"forge.config/1","blocks":{}}');
    const revision = (
      JSON.parse(run("config", "show").stdout) as {
        result: { revision: string };
      }
    ).result.revision;
    expect(
      run("template", "import", "delivery", "--expect-revision", revision)
        .status,
    ).toBe(0);
    const config = readFileSync(configPath, "utf8");
    const synced = run("skills", "sync");
    expect(synced.stdout).toContain('"ok":true');
    expect(synced.status).toBe(0);
    for (const dir of dirs) {
      expect(
        readFileSync(join(root, dir, "forge-loop/agents/openai.yaml"), "utf8"),
      ).toContain("allow_implicit_invocation: false");
      expect(existsSync(join(root, dir, "forge-loop/SKILL.md"))).toBe(true);
      writeFileSync(join(root, dir, "forge-loop/NOTES.md"), "user notes\n");
    }
    expect(run("skills", "sync", "--check").status).toBe(0);
    expect(run("skills", "sync").status).toBe(0);
    for (const dir of dirs) {
      expect(readFileSync(join(root, dir, "forge-loop/NOTES.md"), "utf8")).toBe(
        "user notes\n",
      );
      expect(existsSync(join(root, dir, ".forge-skills.json"))).toBe(true);
    }
    const target = join(root, dirs[0]!, "forge-loop/SKILL.md");
    rmSync(target);
    expect(run("skills", "sync").status).toBe(0);
    expect(existsSync(target)).toBe(true);
    for (const dir of dirs) {
      const skill = join(root, dir, "forge-loop/SKILL.md");
      writeFileSync(skill, readFileSync(skill, "utf8").replace(/\n/g, "\r\n"));
    }
    expect(run("skills", "sync", "--check").status).toBe(0);
    writeFileSync(target, `${readFileSync(target, "utf8")}edited\n`);
    const copies = () =>
      dirs.flatMap((dir) =>
        readdirSync(join(root, dir), { recursive: true })
          .filter((file) => statSync(join(root, dir, String(file))).isFile())
          .map((file) => [
            dir,
            file,
            createHash("sha256")
              .update(readFileSync(join(root, dir, String(file))))
              .digest("hex"),
          ]),
      );
    const before = copies();
    const checked = run("skills", "sync", "--check");
    expect(checked.status).toBe(1);
    expect(checked.stdout).toContain(".claude/skills/forge-loop/SKILL.md");
    expect(checked.stdout).toContain(
      "hand-edited copy; restore its generated content or remove it before syncing",
    );
    expect(copies()).toEqual(before);
    expect(run("skills", "sync").status).toBe(0);
    expect(copies()).toEqual(before);
    rmSync(target);
    expect(run("skills", "sync").status).toBe(0);
    const setAdapters = (adapters: object[]) => {
      const decoded = yamlConfigCodec.decode(config, DEFAULT_PARSE_LIMITS);
      if (!decoded.ok) throw new Error(decoded.error.message);
      const document = decoded.value as {
        blocks: { agent: { config?: object } };
      };
      document.blocks.agent.config = { adapters };
      writeFileSync(configPath, JSON.stringify(document));
    };
    for (const bad of [
      { id: "bad", detect: [], skills: "../outside" },
      { id: "bad", detect: [], skills: root },
      { id: "bad", detect: [], surprise: true },
    ]) {
      setAdapters([bad]);
      const refused = run("skills", "sync");
      expect(refused.status).toBe(6);
      expect(refused.stdout).toContain(
        "surprise" in bad ? "surprise" : "refusing",
      );
    }
    const outside = mkdtempSync(join(tmpdir(), "forge-adapter-outside-"));
    try {
      symlinkSync(
        outside,
        join(root, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
      setAdapters([{ id: "bad", detect: [], skills: "escape/skills" }]);
      expect(run("skills", "sync").status).toBe(6);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    setAdapters([
      { id: "one", detect: [], skills: "same/skills" },
      { id: "two", detect: [], skills: "same/skills" },
    ]);
    const duplicate = run("skills", "sync");
    expect(duplicate.status).toBe(0);
    const result = (
      JSON.parse(duplicate.stdout) as {
        result: { written: string[]; unchanged: string[] };
      }
    ).result;
    expect(new Set(result.written).size).toBe(result.written.length);
    expect(result.unchanged).toEqual([]);
    writeFileSync(configPath, config);
    mkdirSync(join(root, "tpl/skills/temporary"), { recursive: true });
    writeFileSync(
      join(root, "tpl/forge.template.json"),
      JSON.stringify({
        schemaVersion: "forge.template/1",
        id: "acme/temporary",
        version: "1.0.0",
        summary: "Temp skill",
        config: {
          schemaVersion: "forge.config/1",
          blocks: { agent: { source: { builtin: "forge/agent" } } },
        },
      }),
    );
    const source = join(root, "tpl/skills/temporary/SKILL.md");
    const skill = (body: string) =>
      `---\nname: temporary\ndescription: Temporary\n---\n${body}\n`;
    writeFileSync(source, skill("Use <model id> via Claude Code."));
    const currentRevision = (
      JSON.parse(run("config", "show").stdout) as {
        result: { revision: string };
      }
    ).result.revision;
    const importedTemporary = run(
      "template",
      "import",
      "tpl/forge.template.json",
      "--expect-revision",
      currentRevision,
    );
    expect(importedTemporary.status, importedTemporary.stdout).toBe(0);
    expect(run("skills", "sync").status).toBe(0);
    expect(run("skills", "sync", "--check").status).toBe(0);
    writeFileSync(source, skill("Changed template via Claude Code."));
    const staleBefore = copies();
    const stale = run("skills", "sync", "--check");
    expect(stale.status).toBe(1);
    for (const dir of dirs)
      expect(stale.stdout).toContain(`${dir}/temporary/SKILL.md`);
    expect(copies()).toEqual(staleBefore);
    for (const body of ["--model gpt-6.1-sol", "effort: high"])
      for (const check of [false, true]) {
        writeFileSync(source, skill(body));
        const lintBefore = copies();
        const refused = run("skills", "sync", ...(check ? ["--check"] : []));
        expect(refused.status).toBe(1);
        expect(refused.stdout).toContain("temporary/SKILL.md");
        expect(refused.stdout).toContain(body);
        expect(copies()).toEqual(lintBefore);
      }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

test("built delivery import syncs linted router and intake and preserves unrecorded legacy files", () => {
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
    expect(synced.result.removed).not.toContain(".agents/skills/loop/SKILL.md");
    const names = readdirSync(skills).filter((name) =>
      existsSync(join(skills, name, "SKILL.md")),
    );
    expect(names).toContain("forge-loop");
    expect(names).toContain("forge-intake");
    expect(names).toContain("loop");
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
