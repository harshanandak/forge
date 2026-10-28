// [integration] Built CLI probes use synthetic configs and isolated device/project stores.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResultEnvelope } from "../../src/generated/types.ts";

const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");
const inherited: Record<string, string> = {};
for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"])
  if (process.env[name] !== undefined) inherited[name] = process.env[name]!;

function fixture() {
  const work = mkdtempSync(join(tmpdir(), "forge-memory-recovery-"));
  const root = join(work, "project");
  const nested = join(root, "nested");
  const deviceRoot = join(work, "device");
  mkdirSync(join(root, ".forge"), { recursive: true });
  mkdirSync(nested);
  const initialized = spawnSync("git", ["init", "--quiet"], {
    cwd: root,
    env: inherited,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  expect(initialized.status, initialized.stderr).toBe(0);
  return {
    root,
    nested,
    config(value: string) {
      writeFileSync(join(root, ".forge/config.yaml"), value);
    },
    call(args: string[], cwd = root) {
      const result = spawnSync("node", [bin, ...args], {
        cwd,
        env: { ...inherited, FORGE_DEVICE_ROOT: deviceRoot },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      return {
        ...result,
        envelope: JSON.parse(result.stdout) as ResultEnvelope,
      };
    },
    close() {
      rmSync(work, { recursive: true, force: true });
    },
  };
}

test("memory recovery warnings name the config and safe kind without exposing config values on either stream", () => {
  const place = fixture();
  const marker = "SYNTHETIC_NOT_SECRET_MARKER";
  try {
    for (const config of [
      `template: old\nadapters:\n  authToken: ${marker}\n`,
      `schemaVersion: forge.config/1\nblocks: {}\nadapters:\n  authToken: ${marker}\n`,
      `blocks: [${marker}\n`,
      `# ${marker}\n${"# padding\n".repeat(110_000)}`,
    ]) {
      place.config(config);
      for (const verb of ["scope", "rules"]) {
        const result = place.call(["memory", verb]);
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain(marker);
        expect(result.stderr).not.toContain(marker);
        expect(result.envelope.warnings).toHaveLength(1);
        expect(result.envelope.warnings[0]?.code).toBe(
          "PROJECT_CONFIG_UNAVAILABLE",
        );
        expect(result.envelope.warnings[0]?.message).toContain(
          ".forge/config.yaml",
        );
        expect(result.envelope.warnings[0]?.message).toMatch(
          /INPUT_INVALID|LIMIT_EXCEEDED|UNAVAILABLE/,
        );
      }
    }
  } finally {
    place.close();
  }
}, 120_000);

test("healthy full and short configs retain cwd discovery when an ancestor renames or omits memory", () => {
  const place = fixture();
  try {
    for (const full of [true, false]) {
      for (const rename of [true, false]) {
        place.config(
          JSON.stringify({
            ...(full ? { schemaVersion: "forge.config/1" } : {}),
            blocks: rename
              ? {
                  memory: {
                    ...(full ? { source: { builtin: "forge/memory" } } : {}),
                    rename: { memory: "notes" },
                    config: { scope: "repo:override" },
                  },
                }
              : {},
          }),
        );
        const canonical = place.call(["memory", "scope"], place.nested);
        expect(canonical.status).toBe(0);
        expect(canonical.envelope).toMatchObject({
          ok: true,
          result: { scope: "project" },
          warnings: [],
        });
        const renamed = place.call(["notes", "scope"], place.nested);
        expect(renamed.status).toBe(3);
        expect(renamed.envelope).toMatchObject({
          ok: false,
          error: { code: "UNKNOWN_COMMAND" },
        });
        if (rename) {
          const atRoot = place.call(["notes", "scope"]);
          expect(atRoot.status).toBe(0);
          expect(atRoot.envelope).toMatchObject({
            result: { scope: "repo:override" },
            warnings: [],
          });
        }
      }
    }
  } finally {
    place.close();
  }
}, 120_000);

test("an unavailable unrelated block preserves healthy memory override project notes and discovery", () => {
  for (const full of [true, false]) {
    const place = fixture();
    const memory = {
      source: { builtin: "forge/memory" },
      config: {
        scope: "repo:override",
        levels: { human: "device", agent: "required" },
      },
    };
    try {
      place.config(
        JSON.stringify({
          ...(full ? { schemaVersion: "forge.config/1" } : {}),
          blocks: { memory },
        }),
      );
      for (const level of ["device", "project"]) {
        const added = place.call([
          "memory",
          "add",
          "--input",
          JSON.stringify({ text: `${level} heron`, level }),
        ]);
        expect(added.status).toBe(0);
      }
      place.config(
        JSON.stringify({
          ...(full ? { schemaVersion: "forge.config/1" } : {}),
          blocks: {
            memory,
            unrelated: { source: { path: "./missing-block" } },
          },
        }),
      );
      const scoped = place.call(["memory", "scope"]);
      expect(scoped.status).toBe(0);
      expect(scoped.envelope).toMatchObject({
        result: { scope: "repo:override" },
        warnings: [],
      });
      const rules = place.call(["memory", "rules"]);
      expect(rules.status).toBe(0);
      expect(rules.envelope.warnings).toEqual([]);
      if (!rules.envelope.ok) throw Error("Expected memory rules");
      const ruleText = rules.envelope.result as { text: { text: string } };
      expect(ruleText.text.text).toContain("repo:override 2.");
      const searched = place.call(["memory", "search", "heron"]);
      expect(searched.status).toBe(0);
      expect(searched.envelope.warnings).toEqual([]);
      if (!searched.envelope.ok) throw Error("Expected memory search");
      const found = searched.envelope.result as {
        hits: { level: string; snippet: { text: string } }[];
      };
      expect(
        found.hits.map((hit) => ({ level: hit.level, text: hit.snippet.text })),
      ).toEqual([
        { level: "device", text: "device heron" },
        { level: "project", text: "project heron" },
      ]);
    } finally {
      place.close();
    }
  }
}, 120_000);

test("memory config recovery retains healthy unrelated operations", () => {
  const place = fixture();
  try {
    place.config(
      "blocks:\n  memory:\n    typo: true\n  check:\n    commands: {}\n",
    );
    const recovered = place.call(["memory", "scope"]);
    expect(recovered.status).toBe(0);
    expect(recovered.envelope.warnings[0]?.code).toBe(
      "PROJECT_CONFIG_UNAVAILABLE",
    );
    const unrelated = place.call(["check", "list"]);
    expect(unrelated.status).toBe(0);
    expect(unrelated.envelope).toMatchObject({
      ok: true,
      result: { commands: [] },
      warnings: [],
    });
    place.config("unexpected: true\nblocks:\n  memory: {}\n");
    const exported = place.call([
      "memory",
      "export",
      "--input",
      '{"level":"device"}',
    ]);
    expect(exported.status).toBe(0);
    expect(exported.envelope).toMatchObject({ ok: true, warnings: [] });
  } finally {
    place.close();
  }
}, 60_000);
