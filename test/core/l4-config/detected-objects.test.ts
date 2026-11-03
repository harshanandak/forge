import { expect, setDefaultTimeout, test } from "bun:test";
import { DEFAULT_PARSE_LIMITS } from "../../../src/contract/untrusted.ts";
import { makeProject } from "./lib/project.ts";

setDefaultTimeout(30_000);

const pointer = "/blocks/check/config/settings";
const value = { nested: { chosen: "save", sibling: "keep" }, outside: "leave" };
const origin = { detector: "project.detect", file: "settings.json" };
const detections = () => [{ key: pointer, value, origin }];

test("show and explain attribute detected object leaves and their overrides", () => {
  const p = makeProject({ detections });
  try {
    for (const [suffix, leaf] of [
      ["nested/chosen", "save"],
      ["nested/sibling", "keep"],
      ["outside", "leave"],
    ]) {
      expect(p.config.explain({ path: `${pointer}/${suffix}` })).toMatchObject({
        set: true,
        value: leaf,
        source: "derived",
        layer: "derived",
      });
      expect(p.config.show().values).toContainEqual({
        pointer: `${pointer}/${suffix}`,
        value: leaf,
        origin,
        layer: "derived",
        active: true,
      });
    }
    p.config.set({
      path: `${pointer}/nested/chosen`,
      value: "manual",
      expectRevision: p.config.show().revision,
    });
    expect(
      p.config.explain({ path: `${pointer}/nested/chosen` }),
    ).toMatchObject({
      source: "project",
      value: "manual",
    });
    expect(
      p.config.explain({ path: `${pointer}/nested/sibling` }),
    ).toMatchObject({
      source: "derived",
      value: "keep",
    });
    expect(
      p.config
        .show()
        .values.find(
          (entry) =>
            entry.pointer === `${pointer}/nested/chosen` &&
            entry.layer === "derived",
        ),
    ).toEqual({
      pointer: `${pointer}/nested/chosen`,
      value: "save",
      origin,
      layer: "derived",
      active: false,
      overriddenBy: { layer: "project", pointer: `${pointer}/nested/chosen` },
    });
  } finally {
    p.cleanup();
  }
});

test("save writes exactly the selected detected sub-path, or all values when paths are omitted", () => {
  for (const paths of [
    ["check.settings.nested.chosen"],
    ["check.settings.nested"],
    undefined,
  ]) {
    const p = makeProject({ detections });
    try {
      const result = p.config.save({
        expectRevision: p.config.show().revision,
        ...(paths === undefined ? {} : { paths }),
      });
      expect(result.skipped).toEqual([]);
      const text = p.read();
      expect(text).toBeDefined();
      expect(p.env.codec.decode(text ?? "", DEFAULT_PARSE_LIMITS)).toEqual({
        ok: true,
        value: {
          schemaVersion: "forge.config/1",
          blocks: {
            check: {
              source: { builtin: "forge/check" },
              config: {
                settings:
                  paths === undefined
                    ? value
                    : {
                        nested:
                          paths[0] === "check.settings.nested"
                            ? value.nested
                            : { chosen: "save" },
                      },
              },
            },
          },
        },
      });
      if (paths?.[0] === "check.settings.nested.chosen")
        expect(result.saved).toEqual([`${pointer}/nested/chosen`]);
    } finally {
      p.cleanup();
    }
  }
});
