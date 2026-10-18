import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TemplateDocument } from "../../../src/contract/index.ts";
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
  test("import copies plain config and records per-key ownership and provenance", () => {
    const p = project();
    const imported = p.templates.import({
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

  test("importing the same template twice is refused", () => {
    const p = project();
    const first = p.templates.import({
      template: "forge/starter",
      expectRevision: p.config.show().revision,
    });
    expect(
      failureOf(() =>
        p.templates.import({
          template: "forge/starter",
          expectRevision: first.revision,
        }),
      )?.code,
    ).toBe("INPUT_CONFLICT");
  });

  test("import leaves a person's existing value alone and reports the conflict", () => {
    const p = project();
    const mine = p.config.set({
      path: "/blocks/work/source",
      value: { path: "blocks/my-work" },
      expectRevision: p.config.show().revision,
    });
    const imported = p.templates.import({
      template: "forge/starter",
      expectRevision: mine.revision,
    });
    expect(imported.conflicts).toEqual([
      expect.objectContaining({
        pointer: "/blocks/work/source",
        current: { path: "blocks/my-work" },
        upstream: { builtin: "forge/work" },
      }),
    ]);
    expect(p.config.explain({ path: "/blocks/work/source" }).value).toEqual({
      path: "blocks/my-work",
    });
  });

  test("a template file in the project imports like an installed one", () => {
    const p = project();
    writeFileSync(
      join(p.root, "team-template.json"),
      JSON.stringify(starterNext()),
    );
    const imported = p.templates.import({
      template: "./team-template.json",
      expectRevision: p.config.show().revision,
    });
    expect(imported.template).toBe("forge/starter@0.2.0");
    expect(
      failureOf(() =>
        p.templates.import({
          template: "../outside.json",
          expectRevision: imported.revision,
        }),
      )?.code,
    ).toBe("INPUT_INVALID");
  });

  test("compare shows upstream changes key by key against the imported baseline; update applies them and leaves edits", () => {
    const p = project();
    const imported = p.templates.import({
      template: "forge/starter",
      expectRevision: p.config.show().revision,
    });
    // the person edits a key the next version also changes
    const edited = p.config.set({
      path: "/blocks/check/source",
      value: { path: "blocks/my-check" },
      expectRevision: imported.revision,
    });
    p.installed.set("forge/starter", starterNext());

    const compared = p.templates.compare({ template: "forge/starter" });
    expect(compared).toMatchObject({
      imported: "forge/starter@0.1.0",
      upstream: "forge/starter@0.2.0",
      revision: edited.revision,
    });
    expect(compared.changes.map((c) => [c.pointer, c.kind])).toEqual([
      ["/blocks/check/config/timeoutSeconds", "add"],
      ["/blocks/context/source", "remove"],
      ["/blocks/memory/config/scope", "add"],
    ]);
    // compare is a read
    expect(p.config.show().revision).toBe(edited.revision);

    const updated = p.templates.update({
      template: "forge/starter",
      expectRevision: compared.revision,
    });
    expect(updated.template).toBe("forge/starter@0.2.0");
    expect(updated.conflicts).toEqual([]);
    const after = p.config.show();
    expect(after.instances.map((i) => i.name).sort()).toEqual([
      "check",
      "memory",
      "work",
    ]);
    expect(after.effective).toMatchObject({
      blocks: {
        check: {
          source: { path: "blocks/my-check" },
          config: { timeoutSeconds: 600 },
        },
      },
    });
    expect(after.templates.map((t) => t.template)).toEqual([
      "forge/starter@0.2.0",
    ]);
  });

  test("an upstream change to a key the person edited is a conflict until they accept upstream", () => {
    const p = project();
    const imported = p.templates.import({
      template: "forge/starter",
      expectRevision: p.config.show().revision,
    });
    const edited = p.config.set({
      path: "/blocks/work/source",
      value: { path: "blocks/my-work" },
      expectRevision: imported.revision,
    });
    const next = starterNext() as unknown as {
      config: { blocks: Record<string, unknown> };
    };
    next.config.blocks.work = { source: { package: "forge-work-plus" } };
    p.installed.set("forge/starter", next as unknown as TemplateDocument);

    const left = p.templates.update({
      template: "forge/starter",
      expectRevision: edited.revision,
    });
    expect(left.conflicts).toEqual([
      expect.objectContaining({
        pointer: "/blocks/work/source",
        kind: "conflict",
        current: { path: "blocks/my-work" },
      }),
    ]);
    expect(p.config.explain({ path: "/blocks/work/source" }).value).toEqual({
      path: "blocks/my-work",
    });

    // nothing upstream is left to apply except the conflict, which the person now accepts
    const taken = p.templates.update({
      template: "forge/starter",
      expectRevision: left.revision,
      accept: ["/blocks/work/source"],
    });
    expect(taken.applied.map((c) => c.pointer)).toEqual([
      "/blocks/work/source",
    ]);
    expect(p.config.explain({ path: "/blocks/work/source" }).value).toEqual({
      package: "forge-work-plus",
    });
  });

  test("template list shows installed templates and what is imported; an uninstalled import is still listed", () => {
    const p = project();
    const imported = p.templates.import({
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
    expect(imported.receipt).not.toBeNull();
  });

  test("removing a template is revertible like any edit", () => {
    const p = project();
    const imported = p.templates.import({
      template: "forge/starter",
      expectRevision: p.config.show().revision,
    });
    const before = p.read();
    const removed = p.templates.remove({
      template: "forge/starter",
      expectRevision: imported.revision,
    });
    expect(removed.fileRemoved).toBe(true);
    p.config.revert({ expectRevision: removed.revision });
    expect(p.read()).toBe(before);
  });

  test("an unknown template names what is installed", () => {
    const p = project();
    const missing = failureOf(() =>
      p.templates.import({
        template: "io.github.alice/nope",
        expectRevision: p.config.show().revision,
      }),
    );
    expect(missing?.code).toBe("INPUT_INVALID");
    expect(missing?.message).toContain("io.github.alice/nope");
  });
});
