import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  failureOf,
  type Fixture,
  makeProject,
  npmDetections,
} from "./lib/project.ts";

setDefaultTimeout(30_000);

const BROKEN = "blocks: [unclosed\n";

const open: Fixture[] = [];
function project(options: Parameters<typeof makeProject>[0] = {}): Fixture {
  const made = makeProject(options);
  open.push(made);
  return made;
}
afterEach(() => {
  for (const made of open.splice(0)) made.cleanup();
});

describe("sparse edits (behaviours kept from the old config writer)", () => {
  test("a key containing dots stays one key when addressed by pointer", () => {
    const p = project();
    p.config.set({
      path: "/blocks/check/config/commands/test.unit",
      value: "make unit",
      expectRevision: p.config.show().revision,
    });
    expect(p.config.show().effective).toMatchObject({
      blocks: { check: { config: { commands: { "test.unit": "make unit" } } } },
    });
  });

  test("an edit keeps every sibling key", () => {
    const p = project();
    let revision = p.config.set({
      path: "check.commands.test",
      value: "a",
      expectRevision: p.config.show().revision,
    }).revision;
    revision = p.config.set({
      path: "check.commands.lint",
      value: "b",
      expectRevision: revision,
    }).revision;
    p.config.set({ path: "git.base", value: "main", expectRevision: revision });
    expect(p.config.show().effective).toMatchObject({
      blocks: {
        check: { config: { commands: { test: "a", lint: "b" } } },
        git: { config: { base: "main" } },
      },
    });
  });

  test("removing a key prunes the objects it leaves empty, and nothing configured removes the file", () => {
    const p = project();
    const set = p.config.set({
      path: "check.commands.test",
      value: "a",
      expectRevision: p.config.show().revision,
    });
    const pruned = p.config.apply({
      patch: [{ op: "remove", path: "check.commands.test" }],
      expectRevision: set.revision,
    });
    expect(p.config.show().effective).toEqual({
      blocks: { check: { source: { builtin: "forge/check" } } },
    });
    const gone = p.config.apply({
      patch: [{ op: "remove", path: "/blocks/check" }],
      expectRevision: pruned.revision,
    });
    expect(gone.fileRemoved).toBe(true);
    expect(p.read()).toBeUndefined();
  });

  test("a malformed path, an empty patch and edits to provenance records are refused", () => {
    const p = project();
    const { revision } = p.config.show();
    expect(
      failureOf(() =>
        p.config.set({ path: "check", value: 1, expectRevision: revision }),
      )?.code,
    ).toBe("INPUT_INVALID");
    expect(
      failureOf(() =>
        p.config.set({ path: "a..b", value: 1, expectRevision: revision }),
      )?.code,
    ).toBe("INPUT_INVALID");
    expect(
      failureOf(() => p.config.apply({ patch: [], expectRevision: revision }))
        ?.code,
    ).toBe("INPUT_INVALID");
    expect(
      failureOf(() =>
        p.config.set({ path: "/owners", value: {}, expectRevision: revision }),
      )?.message,
    ).toContain("managed by Forge");
    expect(
      failureOf(() =>
        p.config.set({ path: "", value: {}, expectRevision: revision }),
      )?.code,
    ).toBe("INPUT_INVALID");
  });

  test("two first writers racing to create the config: exactly one wins", () => {
    const p = project();
    const { revision } = p.config.show();
    const results = ["first", "second"].map(
      (value) =>
        failureOf(() =>
          p.config.set({
            path: "check.commands.test",
            value,
            expectRevision: revision,
          }),
        )?.code ?? "OK",
    );
    expect(results).toEqual(["OK", "REVISION_CONFLICT"]);
    expect(p.config.explain({ path: "check.commands.test" }).value).toBe(
      "first",
    );
  });

  test("a whole patch applies as one edit with one receipt", () => {
    const p = project();
    const written = p.config.apply({
      patch: [
        {
          op: "set",
          path: "/blocks/mine/source",
          value: { path: "blocks/mine" },
        },
        { op: "set", path: "mine.level", value: 3 },
        { op: "set", path: "/mcp/budget", value: 12 },
      ],
      expectRevision: p.config.show().revision,
    });
    expect(written.changes.map((c) => c.pointer)).toEqual([
      "/blocks/mine/config/level",
      "/blocks/mine/source",
      "/mcp/budget",
    ]);
    expect(readdirSync(join(p.root, ".forge/config-history"))).toEqual([
      "000001.json",
    ]);
  });
});

describe("preview, save and a broken file", () => {
  test("preview shows the exact text and changes without writing; an invalid patch is reported, not thrown", () => {
    const p = project();
    const preview = p.config.preview({
      patch: [{ op: "set", path: "check.commands.test", value: "make test" }],
    });
    expect(preview.valid).toBe(true);
    expect(preview.text).toContain("make test");
    expect(preview.changes).toEqual([
      { pointer: "/blocks/check/config/commands/test", after: "make test" },
      { pointer: "/blocks/check/source", after: { builtin: "forge/check" } },
    ]);
    const bad = p.config.preview({
      patch: [{ op: "set", path: "/nope", value: 1 }],
    });
    expect(bad.valid).toBe(false);
    expect(bad.error?.code).toBe("INPUT_INVALID");
    expect(p.read()).toBeUndefined();
    // applying what preview showed writes exactly that text
    p.config.apply({
      patch: [{ op: "set", path: "check.commands.test", value: "make test" }],
      expectRevision: preview.revision,
    });
    expect(p.read()).toBe(preview.text ?? "");
  });

  test("save writes the active derived values into the project so they stop depending on detection", () => {
    let detections = npmDetections();
    const p = project({ detections: () => detections });
    const mine = p.config.set({
      path: "check.commands.test",
      value: "pnpm test",
      expectRevision: p.config.show().revision,
    });
    const saved = p.config.save({ expectRevision: mine.revision });
    expect(saved.saved).toEqual([
      "/blocks/check/config/commands/lint",
      "/blocks/check/config/packageManager",
      "/blocks/git/config/hookManager",
    ]);
    expect(saved.skipped).toEqual([]);
    detections = [];
    const shown = p.config.show();
    expect(shown.values.every((v) => v.layer === "project")).toBe(true);
    expect(shown.effective).toMatchObject({
      blocks: {
        check: {
          config: { commands: { test: "pnpm test", lint: "npm run lint" } },
        },
        git: { config: { hookManager: "pre-commit" } },
      },
    });
  });

  test("save skips values for an instance nobody can name a source for", () => {
    const p = project({
      detections: () => [
        {
          key: "/blocks/thirdparty/config/x",
          value: 1,
          origin: { detector: "project.detect" },
        },
      ],
    });
    const saved = p.config.save({ expectRevision: p.config.show().revision });
    expect(saved.saved).toEqual([]);
    expect(saved.skipped).toEqual([
      expect.objectContaining({ pointer: "/blocks/thirdparty/config/x" }),
    ]);
    expect(saved.receipt).toBeNull();
  });

  test("a hand-broken file is reported by show and refuses edits with a repair", () => {
    const p = project();
    p.config.set({
      path: "check.commands.test",
      value: "a",
      expectRevision: p.config.show().revision,
    });
    writeFileSync(join(p.root, ".forge/config.yaml"), BROKEN);
    const shown = p.config.show();
    expect(shown.configured).toBe(true);
    expect(shown.problems[0]).toContain("not valid strict YAML");
    const refused = failureOf(() =>
      p.config.set({
        path: "check.commands.test",
        value: "b",
        expectRevision: shown.revision,
      }),
    );
    expect(refused?.code).toBe("INPUT_INVALID");
    // no recorded edit produced the broken bytes, so there is nothing to revert to blindly
    expect(
      failureOf(() => p.config.revert({ expectRevision: shown.revision }))
        ?.code,
    ).toBe("INPUT_INVALID");
    expect(p.read()).toBe(BROKEN);
  });
});
