import { expect, setDefaultTimeout, test } from "bun:test";
import { resolveFileOverlap } from "../../../src/blocks/work/file-overlap.ts";
import schema from "../../../src/blocks/work/schemas/config.json" with { type: "json" };
import { validateWithSchema } from "../../../src/contract/schema.ts";

setDefaultTimeout(5000);

const generatedRule = {
  glob: "src/generated/*.ts",
  regenerate: { argv: ["bun", "run", "gen"] },
};

test("disjoint literal declarations give a complete empty result", () => {
  expect(
    resolveFileOverlap({
      left: { expectedFiles: ["src/a.ts"] },
      right: { expectedFiles: ["src/b.ts"] },
      trackedPaths: ["src/a.ts", "src/b.ts"],
    }),
  ).toEqual({ complete: true, reasons: [], overlaps: [], generated: [] });
});

test("globstar matches zero or many directories and retains both source declarations", () => {
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src/**/*.ts"] },
    right: { expectedFiles: ["src/a/b.ts", "src/base.ts", "src/a/b/c.ts"] },
    trackedPaths: ["src/base.ts", "src/a/b/c.ts", "src/a/b.ts", "src/base.js"],
  });
  expect(result.complete).toBe(true);
  expect(result.overlaps).toEqual(
    ["src/a/b.ts", "src/a/b/c.ts", "src/base.ts"].map((path) => ({
      path,
      leftPattern: "src/**/*.ts",
      rightPattern: path,
    })),
  );
});

test("single star stays within one path segment", () => {
  const paths = ["src/a.ts", "src/deep/b.ts"];
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src/*.ts"] },
    right: { expectedFiles: paths },
    trackedPaths: paths,
  });
  expect(result.complete).toBe(true);
  expect(result.overlaps.map(({ path }) => path)).toEqual(["src/a.ts"]);
});

test("question mark matches one Unicode code point and cannot consume a separator", () => {
  const paths = ["src/a/z.ts", "src/abz.ts", "src/az.ts", "src/a😀z.ts"];
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src/a?z.ts"] },
    right: { expectedFiles: paths },
    trackedPaths: paths,
  });
  expect(result.complete).toBe(true);
  expect(result.overlaps.map(({ path }) => path)).toEqual([
    "src/abz.ts",
    "src/a😀z.ts",
  ]);
});

test("globstar can consume separators within a pattern segment", () => {
  const paths = ["src/az.ts", "src/a/deep/z.ts"];
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src/a**z.ts"] },
    right: { expectedFiles: paths },
    trackedPaths: paths,
  });
  expect(result.complete).toBe(true);
  expect(result.overlaps.map(({ path }) => path)).toEqual([
    "src/a/deep/z.ts",
    "src/az.ts",
  ]);
});

test("case-sensitive paths distinguish both literals and glob matches", () => {
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src/file.ts", "Src/*.ts"] },
    right: { expectedFiles: ["src/File.ts", "src/other.ts"] },
    trackedPaths: ["src/file.ts", "Src/file.ts", "src/File.ts", "src/other.ts"],
  });
  expect(result.complete).toBe(true);
  expect(result.overlaps).toEqual([]);
});

test("literal directories do not expand and slash-star names only immediate files", () => {
  const paths = ["src/.hidden file", "src/deep/nested file"] as const;
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src", "src/*"] },
    right: { expectedFiles: paths },
    trackedPaths: paths,
  });
  expect(result.complete).toBe(true);
  expect(result.overlaps).toEqual([
    { path: paths[0], leftPattern: "src/*", rightPattern: paths[0] },
  ]);
});

test("a literal future file can satisfy another issue's glob", () => {
  const result = resolveFileOverlap({
    left: { expectedFiles: ["**/*.ts"] },
    right: { expectedFiles: ["new file.ts"] },
    trackedPaths: [],
  });
  expect(result.complete).toBe(true);
  expect(result.overlaps).toEqual([
    {
      path: "new file.ts",
      leftPattern: "**/*.ts",
      rightPattern: "new file.ts",
    },
  ]);
});

test("a generated overlap is excluded and reported with its regeneration rule", () => {
  const path = "src/generated/types.ts";
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src/**/*.ts"] },
    right: { expectedFiles: [path] },
    trackedPaths: [],
    generatedFiles: [
      generatedRule,
      { glob: path, regenerate: { argv: ["other-generator"] } },
    ],
  });
  expect(result.complete).toBe(true);
  expect(result.overlaps).toEqual([]);
  expect(result.generated).toEqual([
    {
      path,
      leftPattern: "src/**/*.ts",
      rightPattern: path,
      rule: generatedRule,
    },
  ]);
});

test("mixed overlaps keep handwritten files and classify learned paths", () => {
  const generated = "src/generated/types.ts";
  const handwritten = "src/handwritten.ts";
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src/**/*.ts"], actualFiles: [handwritten] },
    right: { expectedFiles: [handwritten], actualFiles: [generated] },
    trackedPaths: [],
    generatedFiles: [generatedRule],
  });
  expect(result.complete).toBe(true);
  expect(result.overlaps).toEqual([
    { path: handwritten, leftPattern: handwritten, rightPattern: handwritten },
  ]);
  expect(result.generated).toEqual([
    {
      path: generated,
      leftPattern: "src/**/*.ts",
      rightPattern: generated,
      rule: generatedRule,
    },
  ]);
});

test("an unmatched pattern marks an empty overlap incomplete and names its side", () => {
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src/*.ts"] },
    right: { expectedFiles: ["docs/*.md"] },
    trackedPaths: ["docs/readme.md", "src/sub/file.ts"],
  });
  expect(result.complete).toBe(false);
  expect(result.overlaps).toEqual([]);
  expect(result.reasons).toEqual([
    { kind: "unmatched-pattern", side: "left", pattern: "src/*.ts" },
  ]);
});

test("a truncated tracked inventory marks even a known overlap incomplete", () => {
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src/*.ts"] },
    right: { expectedFiles: ["src/a.ts"] },
    trackedPaths: ["src/a.ts"],
    trackedPathsTruncated: true,
  });
  expect(result.complete).toBe(false);
  expect(result.reasons).toEqual([{ kind: "tracked-paths-truncated" }]);
  expect(result.overlaps.map(({ path }) => path)).toEqual(["src/a.ts"]);
});

test("omitted expected lists are unknown, while two explicit empty lists are complete", () => {
  const none = { expectedFiles: [] };
  expect(
    resolveFileOverlap({ left: none, right: none, trackedPaths: [] }),
  ).toEqual({ complete: true, reasons: [], overlaps: [], generated: [] });
  expect(
    resolveFileOverlap({ left: none, right: {}, trackedPaths: [] }),
  ).toEqual({
    complete: false,
    reasons: [{ kind: "undeclared", side: "right" }],
    overlaps: [],
    generated: [],
  });
});

test("learned paths remain literal and available with an unknown expected list", () => {
  const result = resolveFileOverlap({
    left: { actualFiles: ["src/name?.ts"] },
    right: { expectedFiles: ["src/*.ts", "src/name1.ts"] },
    trackedPaths: ["src/name1.ts"],
  });
  expect(result.complete).toBe(false);
  expect(result.reasons).toEqual([{ kind: "undeclared", side: "left" }]);
  expect(result.overlaps).toEqual([
    {
      path: "src/name?.ts",
      leftPattern: "src/name?.ts",
      rightPattern: "src/*.ts",
    },
  ]);
});

test("invalid issue declarations are incomplete and do not inject candidate paths", () => {
  const result = resolveFileOverlap({
    left: { expectedFiles: ["src/[bad].ts", "../outside.ts"] },
    right: { expectedFiles: ["**"] },
    trackedPaths: [],
  });
  expect(result.complete).toBe(false);
  expect(result.overlaps).toEqual([]);
  expect(result.reasons).toEqual([
    { kind: "invalid-declarations", side: "left" },
    { kind: "unmatched-pattern", side: "right", pattern: "**" },
  ]);
});

test("generated file config accepts a bounded list of glob and argv pairs", () => {
  expect(validateWithSchema(schema, {})).toEqual([]);
  expect(validateWithSchema(schema, { generatedFiles: [] })).toEqual([]);
  expect(
    validateWithSchema(schema, {
      generatedFiles: [
        generatedRule,
        { ...generatedRule, glob: "src/**/file ?.json" },
        { ...generatedRule, glob: "src/.file" },
      ],
    }),
  ).toEqual([]);
});

test("generated file config refuses malformed rules and unsupported paths", () => {
  const invalid = [
    generatedRule,
    [null],
    [{ glob: "src/gen.ts" }],
    [{ ...generatedRule, extra: true }],
    [generatedRule, generatedRule],
    Array.from({ length: 65 }, (_, i) => ({
      ...generatedRule,
      glob: "src/" + i + ".ts",
    })),
    ...[
      "",
      "/src/*.ts",
      "C:/src/*.ts",
      "./C:/src/*.ts",
      "!src/*.ts",
      "src/../file",
      "src/./file",
      "src//file",
      "src/",
      "src\\file",
      "src/[ab].ts",
      "src/{a,b}.ts",
      "src/***.ts",
      "src/\u0000file",
      "a".repeat(1025),
    ].map((glob) => [{ ...generatedRule, glob }]),
    ...[
      "bun run gen",
      {},
      { argv: [], shell: true },
      { argv: [] },
      { argv: [""] },
      { argv: ["bun", "a\u0000b"] },
      { argv: ["bun", 1] },
    ].map((regenerate) => [{ ...generatedRule, regenerate }]),
  ];
  for (const generatedFiles of invalid) {
    expect(validateWithSchema(schema, { generatedFiles })).not.toEqual([]);
  }
});
