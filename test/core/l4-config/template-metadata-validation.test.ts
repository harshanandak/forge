import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeProject, starter } from "./lib/project.ts";

setDefaultTimeout(30_000);

for (const [name, document] of [
  ["empty", {}],
  ["values only", { values: { greeting: "saved" } }],
] as const) {
  test(`a template supplies blocks to an existing ${name} config`, () => {
    const p = makeProject();
    try {
      mkdirSync(join(p.root, ".forge"));
      writeFileSync(
        join(p.root, ".forge/config.yaml"),
        JSON.stringify(document),
      );
      const revision = p.config.show().revision;
      expect(
        p.templates.show({ template: "forge/starter" }).imported,
      ).toBeNull();
      expect(p.templates.list().templates).toHaveLength(2);

      const imported = p.templates.importTemplate({
        template: "forge/starter",
        expectRevision: revision,
      });
      expect(imported.template).toBe("forge/starter@0.1.0");
      expect(imported.previousRevision).toBe(revision);
      expect(imported.revision).not.toBe(revision);
      const shown = p.config.show();
      expect(shown.valid).toBe(true);
      expect(shown.revision).toBe(imported.revision);
      expect(shown.effective.blocks).toEqual(starter().config.blocks);
      expect(shown.effective.values).toEqual(
        "values" in document ? document.values : undefined,
      );
      expect(p.read()).toContain("forge/work");
    } finally {
      p.cleanup();
    }
  });
}
