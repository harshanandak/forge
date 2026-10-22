import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { yamlConfigCodec } from "../../../src/adapters/config-yaml/index.ts";
import { DEFAULT_PARSE_LIMITS } from "../../../src/contract/untrusted.ts";
import {
  createConfig,
  createTemplates,
} from "../../../src/core/config/index.ts";
import { makeProject, type Fixture } from "./lib/project.ts";

setDefaultTimeout(30_000);
const projects: Fixture[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) p.cleanup();
});

for (const fallback of [false, true]) {
  test(`edits respect tighter embedding limits before writing (fallback: ${fallback})`, () => {
    const p = makeProject();
    projects.push(p);
    const text = "blocks:\n  git:\n    base: main\n";
    p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
    const config = createConfig({
      ...p.env,
      limits: { ...DEFAULT_PARSE_LIMITS, maxStringLength: 20 },
      codec: {
        ...yamlConfigCodec,
        ...(fallback ? { edit: () => "blocks: {}\n" } : {}),
      },
    });
    expect(config.show().valid).toBe(true);
    expect(() =>
      config.set({
        path: "git.base",
        value: "x".repeat(21),
        expectRevision: config.show().revision,
      }),
    ).toThrow();
    expect(p.read()).toBe(text);
    expect(p.env.files.read(".forge/config.lock")).toBeUndefined();
  });

  test(`edits respect more permissive embedding limits (fallback: ${fallback})`, () => {
    const p = makeProject();
    projects.push(p);
    const base = "x".repeat(DEFAULT_PARSE_LIMITS.maxStringLength + 1);
    const text = `blocks:\n  git:\n    base: '${base}' # retained\n`;
    p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
    const config = createConfig({
      ...p.env,
      limits: { ...DEFAULT_PARSE_LIMITS, maxStringLength: base.length },
      codec: {
        ...yamlConfigCodec,
        ...(fallback ? { edit: () => "blocks: {}\n" } : {}),
      },
    });
    expect(config.show().valid).toBe(true);
    config.set({
      path: "git.sign",
      value: true,
      expectRevision: config.show().revision,
    });
    expect(config.show().valid).toBe(true);
    expect(config.explain({ path: "git.base" }).value).toBe(base);
    expect(config.explain({ path: "git.sign" }).value).toBe(true);
    if (!fallback) expect(p.read()).toContain(`# retained\n`);
  });
}

for (const [failure, edit] of [
  [
    "exception",
    () => {
      throw new Error("edited YAML does not match the planned values");
    },
  ],
  ["invalid YAML", () => "blocks: [broken YAML"],
  ["wrong values", () => "blocks: {}\n"],
] as const) {
  for (const writer of ["apply", "save", "template"] as const) {
    test(`${writer} falls back with a file warning on ${failure}`, () => {
      const p = makeProject({
        detections: () => [
          {
            key: "/blocks/git/config/sign",
            value: true,
            origin: { detector: "project.detect" },
          },
        ],
      });
      projects.push(p);
      p.env.files.write(
        ".forge/config.yaml",
        new TextEncoder().encode(
          "blocks:\n  git:\n    base: 'main' # original\n",
        ),
      );
      const warnings: string[] = [];
      const env = {
        ...p.env,
        codec: { ...yamlConfigCodec, edit },
        warn: (message: string) => warnings.push(message),
      };
      const config = createConfig(env);
      const expectRevision = config.show().revision;
      if (writer === "apply")
        config.apply({
          expectRevision,
          patch: [{ op: "set", path: "git.base", value: "develop" }],
        });
      if (writer === "save")
        config.save({ expectRevision, paths: ["git.sign"] });
      if (writer === "template")
        createTemplates(env).importTemplate({
          template: "forge/starter",
          expectRevision,
        });
      expect(config.show().valid).toBe(true);
      expect(config.explain({ path: "git.base" }).value).toBe(
        writer === "apply" ? "develop" : "main",
      );
      if (writer === "save")
        expect(config.explain({ path: "git.sign" }).source).toBe("project");
      if (writer === "template")
        expect(config.show().templates).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(".forge/config.yaml");
      expect(warnings[0]).toContain("formatting could not be preserved");
    });
  }
}

test("a serializer that also differs from the plan is refused before writing", () => {
  const p = makeProject();
  projects.push(p);
  const text = "blocks:\n  git:\n    base: main\n";
  p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
  const config = createConfig({
    ...p.env,
    codec: {
      ...yamlConfigCodec,
      edit: () => "blocks: {}\n",
      encode: () => "blocks: {}\n",
    },
  });
  expect(() =>
    config.set({
      path: "git.base",
      value: "develop",
      expectRevision: config.show().revision,
    }),
  ).toThrow();
  expect(p.read()).toBe(text);
  expect(p.env.files.read(".forge/config.lock")).toBeUndefined();
});
