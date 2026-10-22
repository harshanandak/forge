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
const text = "blocks:\n  git:\n    base: 'main' # original\n";
const broken = () => ({ text: "blocks: {}\n", formattingLost: false });
for (const edit of [
  () => {
    throw new Error("injected edit failure");
  },
  () => ({ text: "blocks: [broken", formattingLost: false }),
  broken,
]) {
  for (const writer of ["apply", "save", "template"] as const) {
    test(`${writer} validates fallback and emits one warning (${edit.name})`, () => {
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
      p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
      const warnings: string[] = [];
      const env = {
        ...p.env,
        codec: { ...yamlConfigCodec, edit },
        warn: (m: string) => warnings.push(m),
      };
      const config = createConfig(env),
        expectRevision = config.show().revision;
      if (writer === "apply")
        config.set({ path: "git.base", value: "develop", expectRevision });
      if (writer === "save")
        config.save({ paths: ["git.sign"], expectRevision });
      if (writer === "template")
        createTemplates(env).importTemplate({
          template: "forge/starter",
          expectRevision,
        });
      expect(config.show().valid).toBe(true);
      expect(config.explain({ path: "git.base" }).value).toBe(
        writer === "apply" ? "develop" : "main",
      );
      expect(warnings).toEqual([
        ".forge/config.yaml: formatting could not be preserved",
      ]);
    });
  }
}
for (const fallback of [false, true])
  for (const permissive of [false, true]) {
    test(`parse limits apply to edited and fallback text (${fallback}, ${permissive})`, () => {
      const p = makeProject();
      projects.push(p);
      const base = "x".repeat(
        permissive ? DEFAULT_PARSE_LIMITS.maxStringLength + 1 : 21,
      );
      p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
      const warnings: string[] = [];
      const config = createConfig({
        ...p.env,
        warn: (m) => warnings.push(m),
        limits: {
          ...DEFAULT_PARSE_LIMITS,
          maxStringLength: permissive ? base.length : 20,
        },
        codec: { ...yamlConfigCodec, ...(fallback ? { edit: broken } : {}) },
      });
      const write = () =>
        config.set({
          path: "git.base",
          value: base,
          expectRevision: config.show().revision,
        });
      if (permissive) {
        write();
        expect(config.explain({ path: "git.base" }).value).toBe(base);
        if (fallback) expect(warnings).toHaveLength(1);
        else expect(p.read()).toContain("# original");
      } else {
        expect(write).toThrow();
        expect(p.read()).toBe(text);
      }
      expect(p.env.files.read(".forge/config.lock")).toBeUndefined();
    });
  }
test("a wrong serializer is refused without writing", () => {
  const p = makeProject();
  projects.push(p);
  p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
  const config = createConfig({
    ...p.env,
    codec: { ...yamlConfigCodec, edit: broken, encode: () => "blocks: {}\n" },
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
