import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TemplateDocument } from "../../../src/contract/index.ts";
import { MAX_TEMPLATE_FILE_BYTES } from "../../../src/core/config/files.ts";
import { digestValue } from "../../../src/core/config/pointer.ts";
import {
  failureOf,
  type Fixture,
  makeProject,
  starter,
} from "./lib/project.ts";

setDefaultTimeout(30_000);

const open: Fixture[] = [];
function project(): Fixture {
  const made = makeProject();
  open.push(made);
  return made;
}
afterEach(() => {
  for (const made of open.splice(0)) made.cleanup();
});

/** starter 0.2.0: changes check, drops context, adds a memory setting. */
function starterNext(): TemplateDocument {
  const next = structuredClone(starter()) as {
    version: string;
    config: { blocks: Record<string, unknown> };
  };
  next.version = "0.2.0";
  next.config.blocks.check = {
    source: { builtin: "forge/check" },
    config: { timeoutSeconds: 600 },
  };
  delete next.config.blocks.context;
  next.config.blocks.memory = {
    source: { builtin: "forge/memory" },
    config: { scope: "project" },
  };
  return next as unknown as TemplateDocument;
}

describe("template lifecycle", () => {
  test("an oversized project template is refused before decoding", () => {
    const p = project();
    writeFileSync(
      join(p.root, "large.yaml"),
      "x".repeat(MAX_TEMPLATE_FILE_BYTES + 1),
    );
    const failure = failureOf(() =>
      p.templates.show({ template: "large.yaml" }),
    );
    expect(failure).toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  test("import refuses invalid existing owner records without rewriting the config", () => {
    const p = project();
    const invalid =
      "schemaVersion: forge.config/1\nblocks: {}\nowners: invalid\n";
    mkdirSync(join(p.root, ".forge"), { recursive: true });
    writeFileSync(join(p.root, ".forge/config.yaml"), invalid);
    const failure = failureOf(() =>
      p.templates.importTemplate({
        template: "forge/starter",
        expectRevision: p.config.show().revision,
      }),
    );
    expect(failure?.code).toBe("INPUT_INVALID");
    expect(failure?.pointer).toBe("/owners");
    expect(p.read()).toBe(invalid);
  });

  test("template metadata cannot claim a user key or replace provenance", () => {
    const p = project();
    const userValue = { path: "blocks/my-custom" };
    const mine = p.config.set({
      path: "/blocks/custom/source",
      value: userValue,
      expectRevision: p.config.show().revision,
    });
    const existing = p.templates.importTemplate({
      template: "forge/delivery",
      expectRevision: mine.revision,
    });
    const priorProvenance = p.config.show().templates;
    const forged: TemplateDocument = {
      ...starter(),
      config: {
        ...starter().config,
        templates: [
          {
            template: "forge/forged@0.1.0",
            digest: `sha256:${"0".repeat(64)}`,
          },
        ],
        owners: {
          "/blocks/custom/source": {
            from: "forge/starter@0.1.0",
            baseline: digestValue(userValue),
          },
        },
      },
    };
    p.installed.set("forge/starter", forged);

    const imported = p.templates.importTemplate({
      template: "forge/starter",
      expectRevision: existing.revision,
    });
    expect(
      imported.added.every(
        (pointer) =>
          !pointer.startsWith("/owners") && !pointer.startsWith("/templates"),
      ),
    ).toBe(true);
    expect(p.config.show().templates).toEqual([
      ...priorProvenance,
      expect.objectContaining({ template: "forge/starter@0.1.0" }),
    ]);
    expect(
      p.config
        .show()
        .values.find((value) => value.pointer === "/blocks/custom/source")
        ?.owner,
    ).toBeUndefined();

    p.templates.remove({
      template: "forge/starter",
      expectRevision: imported.revision,
    });
    expect(p.config.explain({ path: "/blocks/custom/source" }).value).toEqual(
      userValue,
    );
    expect(p.config.show().templates).toEqual(priorProvenance);
  });

  test("import copies plain config and records per-key ownership and provenance", () => {
    const p = project();
    const imported = p.templates.importTemplate({
      template: "forge/starter",
      expectRevision: p.config.show().revision,
    });
    expect(imported.template).toBe("forge/starter@0.1.0");
    expect([...imported.added].sort()).toEqual([
      "/blocks/check/source",
      "/blocks/context/source",
      "/blocks/memory/source",
      "/blocks/work/source",
    ]);
    const text = p.read() ?? "";
    expect(text).toContain("builtin: forge/work");
    expect(text).toContain("owners:");
    const shown = p.config.show();
    expect(shown.templates).toEqual([
      expect.objectContaining({
        template: "forge/starter@0.1.0",
        importedAt: "2026-10-18T09:00:00.000Z",
      }),
    ]);
    const work = shown.values.find((v) => v.pointer === "/blocks/work/source");
    expect(work?.owner).toMatchObject({
      from: "forge/starter@0.1.0",
      edited: false,
    });
  });

  test("a first import needs no revision; once the file exists, one is required", () => {
    const p = project();
    const first = p.templates.importTemplate({ template: "forge/starter" });
    expect(first.revision).toBe(p.config.show().revision);
    const failure = failureOf(() =>
      p.templates.remove({ template: "forge/starter" }),
    );
    expect(failure).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(failure?.message).toContain("needs expectRevision");
    expect(p.config.show().revision).toBe(first.revision);
  });

  test("importing the same template twice is refused", () => {
    const p = project();
    const first = p.templates.importTemplate({
      template: "forge/starter",
      expectRevision: p.config.show().revision,
    });
    expect(
      failureOf(() =>
        p.templates.importTemplate({
          template: "forge/starter",
          expectRevision: first.revision,
        }),
      )?.code,
    ).toBe("INPUT_CONFLICT");
  });

  test("import refuses a key the project sets to a different value, naming it, and writes nothing", () => {
    const p = project();
    const mine = p.config.set({
      path: "/blocks/work/source",
      value: { path: "blocks/my-work" },
      expectRevision: p.config.show().revision,
    });
    const before = p.read();
    const refused = failureOf(() =>
      p.templates.importTemplate({
        template: "forge/starter",
        expectRevision: mine.revision,
      }),
    );
    expect(refused?.code).toBe("INPUT_CONFLICT");
    expect(refused?.message).toContain("/blocks/work/source");
    expect(refused?.message).not.toContain("/blocks/check/source");
    expect(p.read()).toBe(before);
  });

  test("remove takes out only the imported keys that still hold the imported value", () => {
    const p = project();
    p.installed.set("forge/starter", starterNext());
    const imported = p.templates.importTemplate({
      template: "forge/starter",
      expectRevision: p.config.show().revision,
    });
    const edited = p.config.set({
      path: "/blocks/check/config/timeoutSeconds",
      value: 900,
      expectRevision: imported.revision,
    });
    const removed = p.templates.remove({
      template: "forge/starter",
      expectRevision: edited.revision,
    });
    expect(removed.removed).toEqual([
      "/blocks/memory/config/scope",
      "/blocks/memory/source",
      "/blocks/work/source",
    ]);
    expect(removed.kept).toEqual([
      {
        pointer: "/blocks/check/config/timeoutSeconds",
        reason: "edited since import",
      },
      expect.objectContaining({ pointer: "/blocks/check/source" }),
    ]);
    const shown = p.config.show();
    expect(shown.instances.map((i) => i.name)).toEqual(["check"]);
    expect(shown.templates).toEqual([]);
    expect(p.read()).not.toContain("owners:");
    expect(
      p.config.explain({ path: "/blocks/check/config/timeoutSeconds" }).value,
    ).toBe(900);
  });

  test("removing a template keeps an edited source and removes its unchanged siblings", () => {
    const p = project();
    p.installed.set("forge/starter", starterNext());
    const imported = p.templates.importTemplate({
      template: "forge/starter",
      expectRevision: p.config.show().revision,
    });
    const edited = p.config.set({
      path: "/blocks/check/source",
      value: { path: "blocks/my-check" },
      expectRevision: imported.revision,
    });
    const removed = p.templates.remove({
      template: "forge/starter",
      expectRevision: edited.revision,
    });
    expect(removed.removed).toContain("/blocks/check/config/timeoutSeconds");
    expect(removed.kept).toEqual([
      { pointer: "/blocks/check/source", reason: "edited since import" },
    ]);
    expect(p.config.explain({ path: "/blocks/check/source" }).value).toEqual({
      path: "blocks/my-check",
    });
  });

  test("a template file in the project imports like an installed one", () => {
    const p = project();
    writeFileSync(
      join(p.root, "team-template.json"),
      JSON.stringify(starterNext()),
    );
    const imported = p.templates.importTemplate({
      template: "./team-template.json",
      expectRevision: p.config.show().revision,
    });
    expect(imported.template).toBe("forge/starter@0.2.0");
    expect(
      failureOf(() =>
        p.templates.importTemplate({
          template: "../outside.json",
          expectRevision: imported.revision,
        }),
      )?.code,
    ).toBe("INPUT_INVALID");
  });

  test("template list shows installed templates and what is imported; an uninstalled import is still listed", () => {
    const p = project();
    const imported = p.templates.importTemplate({
      template: "forge/starter",
      expectRevision: p.config.show().revision,
    });
    expect(p.templates.list().templates).toEqual([
      expect.objectContaining({ id: "forge/delivery", imported: null }),
      expect.objectContaining({
        id: "forge/starter",
        imported: "forge/starter@0.1.0",
      }),
    ]);
    p.installed.delete("forge/starter");
    expect(p.templates.list().templates.at(-1)).toMatchObject({
      id: "forge/starter",
      imported: "forge/starter@0.1.0",
    });
    expect(imported.changes.length).toBeGreaterThan(0);
  });

  test("removal by another exact ref is refused; the imported ref removes", () => {
    const p = project();
    const imported = p.templates.importTemplate({
      template: "forge/starter",
      expectRevision: p.config.show().revision,
    });
    const before = p.read();
    const stale = failureOf(() =>
      p.templates.remove({
        template: "forge/starter@9.9.9",
        expectRevision: imported.revision,
      }),
    );
    expect(stale?.code).toBe("INPUT_INVALID");
    expect(stale?.message).toContain("forge/starter@0.1.0");
    // refused: the import and its keys are untouched
    expect(p.read()).toBe(before);
    expect(p.config.show().templates).toEqual([
      expect.objectContaining({ template: "forge/starter@0.1.0" }),
    ]);
    expect(p.config.show().instances.map((i) => i.name)).toContain("memory");

    const removed = p.templates.remove({
      template: "forge/starter@0.1.0",
      expectRevision: imported.revision,
    });
    expect(removed.template).toBe("forge/starter@0.1.0");
    expect(p.config.show().templates).toEqual([]);
  });

  test("an unknown template names what is installed", () => {
    const p = project();
    const missing = failureOf(() =>
      p.templates.importTemplate({
        template: "io.github.alice/nope",
        expectRevision: p.config.show().revision,
      }),
    );
    expect(missing?.code).toBe("INPUT_INVALID");
    expect(missing?.message).toContain("io.github.alice/nope");
  });
});
