// L4 acceptance: each test is one journey an agent or person takes through the config API on a
// real project directory, with the real YAML codec.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  failureOf,
  type Fixture,
  makeProject,
  npmDetections,
} from "./lib/project.ts";

setDefaultTimeout(30_000);

const open: Fixture[] = [];
function project(options: Parameters<typeof makeProject>[0] = {}): Fixture {
  const made = makeProject(options);
  open.push(made);
  return made;
}
afterEach(() => {
  for (const made of open.splice(0)) made.cleanup();
});

describe("nothing configured: the core adapts", () => {
  test("config show lists derived values with their sources and switches nothing on", () => {
    const p = project({ detections: npmDetections });
    const shown = p.config.show();

    expect(shown.configured).toBe(false);
    expect(shown.instances).toEqual([]);
    expect(shown.templates).toEqual([]);
    expect(shown.effective).toEqual({
      blocks: {
        check: {
          config: {
            commands: { test: "npm test", lint: "npm run lint" },
            packageManager: "npm",
          },
        },
        git: { config: { hookManager: "pre-commit" } },
      },
    });
    const test_ = shown.values.find(
      (v) => v.pointer === "/blocks/check/config/commands/test",
    );
    expect(test_).toEqual({
      pointer: "/blocks/check/config/commands/test",
      value: "npm test",
      layer: "derived",
      origin: {
        detector: "project.detect",
        file: "package.json",
        pointer: "/scripts/test",
      },
      active: true,
    });
    expect(
      shown.values.every(
        (v) => v.layer === "derived" && v.origin !== undefined,
      ),
    ).toBe(true);

    // zero gates or hooks: no instance, no source, no binding, no exposure came from detection
    const pointers = shown.values.map((v) => v.pointer);
    expect(
      pointers.some((ptr) => /\/(source|enabled|bind|rename)(\/|$)/.test(ptr)),
    ).toBe(false);
    expect(Object.hasOwn(shown.effective, "mcp")).toBe(false);
    expect(shown.ignored.map((i) => i.key)).toEqual([
      "/blocks/check/source",
      "/mcp/expose",
      "/blocks/check/config/commands/test",
    ]);
  });

  test("reads never write: show, explain and detect leave the project untouched", () => {
    const p = project({ detections: npmDetections });
    p.config.show();
    p.config.explain({ path: "check.commands.test" });
    p.config.detect();
    p.templates.list();
    expect(existsSync(join(p.root, ".forge"))).toBe(false);
  });

  test("the derived layer follows the project as it changes", () => {
    let detections = npmDetections();
    const p = project({ detections: () => detections });
    expect(p.config.explain({ path: "check.commands.test" }).value).toBe(
      "npm test",
    );
    detections = [
      {
        key: "/blocks/check/config/commands/test",
        value: "make test",
        origin: { detector: "project.detect", file: "Makefile" },
      },
    ];
    expect(p.config.explain({ path: "check.commands.test" })).toMatchObject({
      value: "make test",
      layer: "derived",
    });
  });
});

describe("configure as you go", () => {
  test("an explicit set overrides the derived value, which stays visible as overridden", () => {
    const p = project({ detections: npmDetections });
    const { revision } = p.config.show();
    const written = p.config.set({
      path: "check.commands.test",
      value: "pnpm vitest run",
      expectRevision: revision,
    });
    expect(written.receipt).not.toBeNull();

    const explained = p.config.explain({ path: "check.commands.test" });
    expect(explained.value).toBe("pnpm vitest run");
    expect(explained.layer).toBe("project");
    expect(explained.entries).toEqual([
      {
        pointer: "/blocks/check/config/commands/test",
        value: "pnpm vitest run",
        layer: "project",
        active: true,
      },
      {
        pointer: "/blocks/check/config/commands/test",
        value: "npm test",
        layer: "derived",
        origin: {
          detector: "project.detect",
          file: "package.json",
          pointer: "/scripts/test",
        },
        active: false,
        overriddenBy: {
          layer: "project",
          pointer: "/blocks/check/config/commands/test",
        },
      },
    ]);
    // the person named the block, so it is configured; the other derived values still apply
    const shown = p.config.show();
    expect(shown.instances).toEqual([
      { name: "check", source: { builtin: "forge/check" }, enabled: true },
    ]);
    expect(shown.effective).toMatchObject({
      blocks: {
        check: {
          config: {
            commands: { test: "pnpm vitest run", lint: "npm run lint" },
          },
        },
      },
    });
    expect(p.read()).toContain("pnpm vitest run");
  });

  test("an invocation value overrides both for one call and is never written", () => {
    const p = project({ detections: npmDetections });
    const shown = p.config.show({
      invocation: [
        { op: "set", path: "check.commands.test", value: "npm run test:ci" },
      ],
    });
    expect(shown.effective).toMatchObject({
      blocks: { check: { config: { commands: { test: "npm run test:ci" } } } },
    });
    expect(
      shown.values.find(
        (v) => v.layer === "derived" && v.pointer.endsWith("/test"),
      )?.active,
    ).toBe(false);
    expect(p.read()).toBeUndefined();
  });

  test("a conflicting concurrent edit is refused and the first edit stands", () => {
    const p = project({ detections: npmDetections });
    const { revision } = p.config.show();
    // two agents read the same revision
    p.config.set({
      path: "check.commands.test",
      value: "pnpm test",
      expectRevision: revision,
    });
    const refused = failureOf(() =>
      p.config.set({
        path: "check.commands.test",
        value: "yarn test",
        expectRevision: revision,
      }),
    );
    expect(refused?.code).toBe("REVISION_CONFLICT");
    expect(p.config.explain({ path: "check.commands.test" }).value).toBe(
      "pnpm test",
    );
  });

  test("an edit racing another inside the write window is refused, not interleaved", () => {
    let racer: (() => void) | undefined;
    const p = project({
      detections: npmDetections,
      files: (real) => ({
        ...real,
        write(path, bytes) {
          const run = racer;
          racer = undefined;
          run?.();
          real.write(path, bytes);
        },
      }),
    });
    const { revision } = p.config.show();
    let raced: ReturnType<typeof failureOf>;
    racer = () => {
      raced = failureOf(() =>
        p.config.set({
          path: "check.commands.lint",
          value: "yarn lint",
          expectRevision: revision,
        }),
      );
    };
    p.config.set({
      path: "check.commands.test",
      value: "pnpm test",
      expectRevision: revision,
    });
    expect(raced?.code).toBe("REVISION_CONFLICT");
    expect(p.config.explain({ path: "check.commands.lint" }).layer).toBe(
      "derived",
    );
    expect(existsSync(join(p.root, ".forge/config.lock"))).toBe(false);
  });

  test("revert restores the exact prior bytes, comments and layout included", () => {
    const p = project();
    const original =
      '# our hand-written config\nschemaVersion: forge.config/1\nblocks:\n  check:   # spacing kept\n    source: {builtin: forge/check}\n    config:\n      commands: {test: "make test"}\n';
    mkdirSync(join(p.root, ".forge"));
    writeFileSync(join(p.root, ".forge/config.yaml"), original);
    const before = readFileSync(join(p.root, ".forge/config.yaml"));

    const { revision } = p.config.show();
    const written = p.config.set({
      path: "check.commands.test",
      value: "make check",
      expectRevision: revision,
    });
    expect(p.read()).not.toBe(original);

    const reverted = p.config.revert({ expectRevision: written.revision });
    expect(reverted.reverted).toBe(written.receipt as string);
    expect(
      readFileSync(join(p.root, ".forge/config.yaml")).equals(before),
    ).toBe(true);
    expect(reverted.revision).toBe(revision);
  });

  test("reverting the edit that created the file removes it again", () => {
    const p = project({ detections: npmDetections });
    const { revision } = p.config.show();
    const written = p.config.set({
      path: "check.commands.test",
      value: "pnpm test",
      expectRevision: revision,
    });
    const reverted = p.config.revert({ expectRevision: written.revision });
    expect(reverted.fileRemoved).toBe(true);
    expect(p.read()).toBeUndefined();
    expect(p.config.show().configured).toBe(false);
  });

  test("reverting walks back one edit at a time", () => {
    const p = project();
    const first = p.config.set({
      path: "check.commands.test",
      value: "one",
      expectRevision: p.config.show().revision,
    });
    const second = p.config.set({
      path: "check.commands.test",
      value: "two",
      expectRevision: first.revision,
    });
    const back1 = p.config.revert({ expectRevision: second.revision });
    expect(p.config.explain({ path: "check.commands.test" }).value).toBe("one");
    p.config.revert({ expectRevision: back1.revision });
    expect(p.read()).toBeUndefined();
    expect(
      failureOf(() =>
        p.config.revert({ expectRevision: p.config.show().revision }),
      )?.code,
    ).toBe("INPUT_INVALID");
  });

  test("unknown keys are refused and nothing is written", () => {
    const p = project({
      configSchema: (_name, source) =>
        "builtin" in source && source.builtin === "forge/check"
          ? {
              type: "object",
              properties: {
                commands: {
                  type: "object",
                  additionalProperties: { type: "string" },
                },
              },
              additionalProperties: false,
            }
          : undefined,
    });
    const { revision } = p.config.show();
    const typo = failureOf(() =>
      p.config.set({
        path: "/blocks/check/sorce",
        value: { builtin: "forge/check" },
        expectRevision: revision,
      }),
    );
    expect(typo).toMatchObject({
      code: "INPUT_INVALID",
      pointer: "/blocks/check/sorce",
    });
    expect(typo?.message).toContain("sorce");
    expect(
      failureOf(() =>
        p.config.set({ path: "/plugins", value: [], expectRevision: revision }),
      )?.code,
    ).toBe("INPUT_INVALID");
    const inner = failureOf(() =>
      p.config.set({
        path: "check.comands.test",
        value: "x",
        expectRevision: revision,
      }),
    );
    expect(inner).toMatchObject({
      code: "INPUT_INVALID",
      pointer: "/blocks/check/config/comands",
    });
    expect(inner?.message).toContain("comands");
    expect(
      failureOf(() =>
        p.config.set({
          path: "nosuchblock.key",
          value: 1,
          expectRevision: revision,
        }),
      )?.message,
    ).toContain('no installed block is named "nosuchblock"');
    expect(p.read()).toBeUndefined();
  });
});

describe("templates", () => {
  test("two templates, a user edit and a removal: the edit stays, only owned unchanged keys go", () => {
    const p = project({ detections: npmDetections });
    let revision = p.config.show().revision;
    const d = p.templates.import({
      template: "forge/delivery",
      expectRevision: revision,
    });
    expect(d.conflicts).toEqual([]);
    const s = p.templates.import({
      template: "forge/starter",
      expectRevision: d.revision,
    });
    expect(s.added).toEqual([]);
    expect([...s.shared].sort()).toEqual([
      "/blocks/check/source",
      "/blocks/context/source",
      "/blocks/memory/source",
      "/blocks/work/source",
    ]);
    // the person edits one imported value and adds one of their own
    revision = p.config.set({
      path: "pr.merge.settleMinutes",
      value: 15,
      expectRevision: s.revision,
    }).revision;
    revision = p.config.set({
      path: "check.commands.test",
      value: "pnpm vitest run",
      expectRevision: revision,
    }).revision;

    const removed = p.templates.remove({
      template: "forge/delivery",
      expectRevision: revision,
    });
    const after = p.config.show();
    expect(after.instances.map((i) => i.name).sort()).toEqual([
      "check",
      "context",
      "memory",
      "pr",
      "work",
    ]);
    expect(after.templates.map((t) => t.template)).toEqual([
      "forge/starter@0.1.0",
    ]);
    // the edit is kept, and so is the source of the instance it lives in
    expect(after.effective).toMatchObject({
      blocks: {
        pr: {
          source: { builtin: "forge/pr" },
          config: { merge: { settleMinutes: 15 } },
        },
        check: { config: { commands: { test: "pnpm vitest run" } } },
      },
    });
    const prMerge = (
      after.effective as {
        blocks: { pr: { config: { merge: Record<string, unknown> } } };
      }
    ).blocks.pr.config.merge;
    expect(prMerge).toEqual({ settleMinutes: 15 });
    expect(removed.kept.map((k) => k.pointer)).toEqual([
      "/blocks/check/source",
      "/blocks/context/source",
      "/blocks/memory/source",
      "/blocks/pr/config/merge/settleMinutes",
      "/blocks/pr/source",
      "/blocks/work/source",
    ]);
    expect(removed.removed).toContain("/blocks/policy/config/rules");
    expect(removed.removed).toContain("/mcp/budget");
    expect(removed.removed).not.toContain(
      "/blocks/pr/config/merge/settleMinutes",
    );
    // keys shared with starter now belong to starter
    expect(
      p.templates
        .show({ template: "forge/starter" })
        .owned.map((o) => o.pointer)
        .sort(),
    ).toEqual([
      "/blocks/check/source",
      "/blocks/context/source",
      "/blocks/memory/source",
      "/blocks/work/source",
    ]);

    const last = p.templates.remove({
      template: "forge/starter",
      expectRevision: removed.revision,
    });
    expect([...last.removed].sort()).toEqual([
      "/blocks/context/source",
      "/blocks/memory/source",
      "/blocks/work/source",
    ]);
    const final = p.config.show();
    expect(final.templates).toEqual([]);
    expect(final.instances.map((i) => i.name).sort()).toEqual(["check", "pr"]);
    expect(final.effective).toMatchObject({
      blocks: {
        pr: { config: { merge: { settleMinutes: 15 } } },
        check: {
          config: {
            commands: { test: "pnpm vitest run", lint: "npm run lint" },
          },
        },
      },
    });
  });

  test("removing every template returns the project to the adaptive layer", () => {
    const p = project({ detections: npmDetections });
    const adaptive = p.config.show();
    const d = p.templates.import({
      template: "forge/delivery",
      expectRevision: adaptive.revision,
    });
    const s = p.templates.import({
      template: "forge/starter",
      expectRevision: d.revision,
    });
    expect(p.config.show().instances.length).toBe(10);
    const r1 = p.templates.remove({
      template: "forge/starter",
      expectRevision: s.revision,
    });
    const r2 = p.templates.remove({
      template: "forge/delivery",
      expectRevision: r1.revision,
    });
    expect(r2.fileRemoved).toBe(true);
    expect(p.read()).toBeUndefined();
    const back = p.config.show();
    expect(back).toEqual(adaptive);
  });
});
