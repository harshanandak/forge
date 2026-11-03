import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failureOf, makeProject } from "./lib/project.ts";

setDefaultTimeout(30_000);

const cases = [
  ["missing template", {}, "/templates/0/template"],
  [
    "missing digest",
    { template: "forge/starter@0.1.0", importedAt: "2026-10-18T09:00:00Z" },
    "/templates/0/digest",
  ],
  ["null record", null, "/templates/0"],
  ["string record", "forge/starter@0.1.0", "/templates/0"],
] as const;

for (const [name, record, pointer] of cases) {
  test(`template operations diagnose a ${name} before reading provenance`, () => {
    const p = makeProject();
    try {
      mkdirSync(join(p.root, ".forge"));
      writeFileSync(
        join(p.root, ".forge/config.yaml"),
        JSON.stringify({ blocks: { check: {} }, templates: [record] }),
      );
      const before = p.read();
      const shown = p.config.show();
      expect(shown.valid).toBe(false);
      expect(shown.templates).toEqual([]);
      expect(shown.excluded.map(({ pointer }) => pointer)).toEqual([
        "/templates/0",
      ]);
      expect(shown.excluded[0]?.problems.length).toBeGreaterThan(0);
      expect(shown.problems.join("\n")).toContain("templates.0");
      expect(p.config.explain({ path: "/blocks/check/source" }).value).toEqual({
        builtin: "forge/check",
      });

      for (const call of [
        () => p.templates.list(),
        () => p.templates.show({ template: "forge/starter" }),
        () =>
          p.templates.importTemplate({
            template: "forge/starter",
            expectRevision: shown.revision,
          }),
        () =>
          p.templates.remove({
            template: "forge/starter",
            expectRevision: shown.revision,
          }),
      ]) {
        const failure = failureOf(call);
        expect(failure).toMatchObject({ code: "INPUT_INVALID", pointer });
        expect(failure?.message).toContain(pointer);
        expect(p.read()).toBe(before);
      }
    } finally {
      p.cleanup();
    }
  });
}
