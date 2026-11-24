import { describe, expect, test } from "bun:test";
import {
  findHubImportPurityViolations,
  isHubSource,
} from "./lib/hub-import-purity.ts";
import { format, listRepoFiles, readRepoFiles } from "./lib/repo.ts";

const allowed = {
  imports: `
    import "./setup.ts";
    import source, { original as renamed } from "./source.ts";
    import * as values from "./values.ts";
    import type { Item } from "./types.ts";
    export { renamed as outward };
    export { other } from "./other.ts";
    export * from "./all.ts";
    export const selected = [source.value, values.items, renamed];
  `,
  types: `
    export type Count = number;
    export interface Item { count: Count }
    declare const ambient: number;
    declare function ambientFunction(): void;
    declare namespace Library { type Value = number }
    export enum State { Pending, Done = 2 }
    enum Label { Ready = "ready" }
  `,
  functions: `
    export function later() { return new Map(); }
    const arrow = () => Object.freeze({});
    const expression = function () { return perform(); };
    export default function () { return perform(); }
  `,
  classes: `
    import * as bases from "./bases.ts";
    const key = "id";
    export class Item extends bases.Base {
      [key] = initializeInstance();
      static ["count"] = 1;
      static get value() { return initializeOnRead(); }
      method() { return perform(); }
    }
    export const Factory = class extends Item { static label = "idle"; };
    export default class extends Error {}
  `,
  values: [
    'const base = { count: 1, label: "ready" };',
    'let values = ["s", 1, 2n, true, false, null, /yes/, `literal`, undefined];',
    'const key = "count";',
    "const object = { ...base, [key]: base.count, key };",
    "const list = [...values, object, -1, !false, ~1, 1 + 2, typeof base];",
    "const checked = (base.count as number)! satisfies number;",
    "const tuple = [checked] as const;",
    "export default `count: ${base.count}`;",
  ].join("\n"),
};

const denied: readonly (readonly [
  name: string,
  text: string,
  line: number,
  form: string,
])[] = [
  ["call", "const value =\n  compute();", 2, "CallExpression"],
  [
    "constructor",
    "const before = 1;\nconst value = new Map();",
    2,
    "NewExpression",
  ],
  ["freeze", "const value = Object.freeze({});", 1, "CallExpression"],
  ["await", "export {};\nconst value = await compute();", 2, "AwaitExpression"],
  ["using", "using h = resource;", 1, "VariableStatement"],
  [
    "await using",
    "export {};\nawait using h = resource;",
    2,
    "VariableStatement",
  ],
  [
    "expression statement",
    "const before = 1;\nvoid before;",
    2,
    "ExpressionStatement",
  ],
  [
    "static block",
    "class Example {\n  static { compute(); }\n}",
    2,
    "ClassStaticBlockDeclaration",
  ],
  [
    "static field",
    "class Example {\n  static value = compute();\n}",
    2,
    "CallExpression",
  ],
  [
    "tagged template",
    "const before = 1;\nconst value = tag`hello`;",
    2,
    "TaggedTemplateExpression",
  ],
  [
    "env in a call",
    "const value =\n  consume(process.env.X);",
    2,
    "CallExpression",
  ],
  ["IIFE", "const value =\n  (() => 1)();", 2, "CallExpression"],
  ["heritage", "class Example extends\n  mixin(Base) {}", 2, "CallExpression"],
  [
    "instance key",
    "class Example {\n  [compute()]: number;\n}",
    2,
    "CallExpression",
  ],
  [
    "static key",
    "class Example {\n  static [compute()] = 1;\n}",
    2,
    "CallExpression",
  ],
  ["object key", "const value = {\n  [compute()]: 1,\n};", 2, "CallExpression"],
  ["default export", "export default\n  compute();", 2, "CallExpression"],
  ["export equals", "const value = 1;\nexport = value;", 2, "ExportAssignment"],
  [
    "dynamic import",
    'const value = import("./other.ts");',
    1,
    "CallExpression",
  ],
  [
    "assignment",
    "let value = 0;\nconst next = (value += 1);",
    2,
    "BinaryExpression",
  ],
  [
    "delete",
    "const value = { a: 1 };\nconst removed = delete value.a;",
    2,
    "DeleteExpression",
  ],
  ["if", "if (enabled) { compute(); }", 1, "IfStatement"],
  ["for", "for (const item of items) { compute(item); }", 1, "ForOfStatement"],
  ["try", "try { compute(); } catch {}", 1, "TryStatement"],
  ["ambient read", "const value = process.env;", 1, "PropertyAccessExpression"],
  [
    "nonliteral enum",
    "enum State {\n  Ready = compute(),\n}",
    2,
    "CallExpression",
  ],
  ["decorator", "@decorate\nclass Example {}", 1, "Decorator"],
];

function fixture(name: string, text: string) {
  return { path: `hub/src/fixtures/${name.replaceAll(" ", "-")}.ts`, text };
}

function scanHubSources(list = listRepoFiles, read = readRepoFiles) {
  return findHubImportPurityViolations(read(list().filter(isHubSource)));
}

describe("hub import purity blocks accidental module-scope work and accepts implicit execution by getters, coercion and iterators", () => {
  test("allows inert declarations and expressions", async () => {
    const files = Object.entries(allowed).map(([name, text]) =>
      fixture(name, text),
    );
    expect(format(await findHubImportPurityViolations(files))).toEqual([]);
  }, 30_000);

  test("reports every forbidden form at its source line", async () => {
    const files = denied.map(([name, text]) => fixture(name, text));
    const violations = await findHubImportPurityViolations(files);
    const byFile = new Map(
      violations.map((violation) => [violation.file, violation]),
    );
    expect(violations).toHaveLength(denied.length);
    for (const [name, text, line, form] of denied) {
      const file = fixture(name, text).path;
      const violation = byFile.get(file);
      expect(violation, file).toMatchObject({
        rule: "hub-import-purity",
        file,
        line,
      });
      expect(violation?.message, file).toContain(form);
    }
  }, 30_000);

  test("discovers existing and new hub sources and checks their contents", async () => {
    const nested = "hub/src/chat/state.ts";
    const future = "hub/src/new-feature/nested/entry.ts";
    const paths = [
      "hub/src/main.ts",
      nested,
      future,
      "hub/src/chat/state.test.ts",
      "hub/src/chat/state.spec.ts",
      "hub/src/chat/state_test.ts",
      "hub/src/chat/state_spec.ts",
      "hub/src/chat/test/support.ts",
      "hub/src/chat/adapter.js",
      "hub/build/entry.ts",
    ];
    const violations = await scanHubSources(
      () => paths,
      (selected) => {
        expect(selected).toEqual(["hub/src/main.ts", nested, future]);
        return selected.map((path) => ({
          path,
          text:
            path === future
              ? "const ready = true;\nconst cache = new Map();"
              : "export const ready = true;",
        }));
      },
    );
    expect(format(violations)).toEqual([
      `[hub-import-purity] ${future}:2 NewExpression at module scope`,
    ]);
  }, 30_000);

  test("checks the non-test TypeScript tree under hub/src", async () => {
    const violations = await scanHubSources(listRepoFiles, (paths) => {
      expect(paths).toContain("hub/src/main.ts");
      return readRepoFiles(paths);
    });
    expect(format(violations)).toEqual([]);
  }, 30_000);
});
