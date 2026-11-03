import { expect, setDefaultTimeout, test } from "bun:test";
import { entriesAt, resolveLayers } from "../../../src/core/config/layers.ts";
import { getIn } from "../../../src/core/config/pointer.ts";
import { failureOf, makeProject } from "./lib/project.ts";

setDefaultTimeout(5000);

for (const [path, value] of [
  ["/templates", []],
  ["/owners", {}],
  ["/schemaVersion", "forge.config/1"],
] as const) {
  test(`config show refuses managed metadata at ${path} just like config set`, () => {
    const p = makeProject();
    try {
      p.templates.importTemplate({
        template: "forge/starter",
        expectRevision: p.config.show().revision,
      });
      const before = p.read();
      const baseline = p.config.show();
      expect(baseline.templates).toHaveLength(1);
      const written = failureOf(() =>
        p.config.set({ path, value, expectRevision: baseline.revision }),
      );
      expect(written).toMatchObject({
        code: "INPUT_INVALID",
        message: `${path} is managed by Forge and cannot be edited directly`,
        repair:
          "import or remove templates with template import and template remove",
      });
      expect(
        failureOf(() =>
          p.config.show({ invocation: [{ op: "set", path, value }] }),
        ),
      ).toEqual(written);
      expect(p.read()).toBe(before);
      expect(p.config.show()).toEqual(baseline);
    } finally {
      p.cleanup();
    }
  });
}

const commands = ["blocks", "check", "config", "commands"];
const pointer = "/blocks/check/config/commands";
const lower = { test: "node --test" };

for (const layer of ["default", "derived", "project"] as const) {
  test(`an empty invocation object replaces ${layer} descendants and their active provenance`, () => {
    const layers = resolveLayers(
      {
        entries:
          layer === "derived"
            ? [
                {
                  segments: [...commands, "test"],
                  value: lower.test,
                  origin: { detector: "project.detect", file: "package.json" },
                },
              ]
            : [],
        ignored: [],
      },
      layer === "project"
        ? { blocks: { check: { config: { commands: lower } } } }
        : undefined,
      [{ segments: commands, value: {} }],
      layer === "default"
        ? [{ segments: [...commands, "test"], value: lower.test }]
        : [],
    );

    expect(getIn(layers.effective, commands)).toEqual({});
    expect(getIn(layers.effective, [...commands, "test"])).toBeUndefined();
    const explained = entriesAt(layers, commands);
    expect(explained.filter((entry) => entry.active)).toEqual([
      { pointer, value: {}, layer: "invocation", active: true },
    ]);
    expect(explained.filter((entry) => entry.layer === layer)).toEqual([
      {
        pointer: `${pointer}/test`,
        value: lower.test,
        layer,
        ...(layer === "derived"
          ? { origin: { detector: "project.detect", file: "package.json" } }
          : {}),
        active: false,
        overriddenBy: { layer: "invocation", pointer },
      },
    ]);
  });
}

test("config show clears a project object for one invocation without writing it", () => {
  const p = makeProject();
  try {
    p.config.set({
      path: "check.commands",
      value: lower,
      expectRevision: p.config.show().revision,
    });
    const before = p.read();
    const shown = p.config.show({
      invocation: [{ op: "set", path: "check.commands", value: {} }],
    });
    expect(getIn(shown.effective, commands)).toEqual({});
    expect(
      shown.values.filter(
        (entry) => entry.active && entry.pointer.startsWith(pointer),
      ),
    ).toEqual([{ pointer, value: {}, layer: "invocation", active: true }]);
    expect(p.read()).toBe(before);
    expect(p.config.explain({ path: "check.commands" }).value).toEqual(lower);
  } finally {
    p.cleanup();
  }
});

test("non-empty invocation objects preserve lower sibling paths, and omitted paths stay effective", () => {
  const document = { blocks: { check: { config: { commands: lower } } } };
  const layers = resolveLayers({ entries: [], ignored: [] }, document, [
    { segments: [...commands, "lint"], value: { command: "lint" } },
  ]);
  expect(getIn(layers.effective, commands)).toEqual({
    ...lower,
    lint: { command: "lint" },
  });
  expect(
    getIn(
      resolveLayers({ entries: [], ignored: [] }, document).effective,
      commands,
    ),
  ).toEqual(lower);
});

for (const layer of ["project", "invocation"] as const) {
  test(`an empty ${layer} object over an exact object default remains a replacement`, () => {
    const layers = resolveLayers(
      { entries: [], ignored: [] },
      layer === "project"
        ? { blocks: { check: { config: { commands: {} } } } }
        : undefined,
      layer === "invocation" ? [{ segments: commands, value: {} }] : [],
      [{ segments: commands, value: lower }],
    );
    expect(getIn(layers.effective, commands)).toEqual({});
    expect(entriesAt(layers, commands).filter((entry) => entry.active)).toEqual(
      [{ pointer, value: {}, layer, active: true }],
    );
  });
}
