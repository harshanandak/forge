import { expect, test } from "bun:test";
import { affectedTests } from "../../tools/ci/affected-tests.ts";

const target = "src/blocks/memory/store.ts";
const consumer = "test/blocks/memory/store.test.ts";
const standalone = "test/blocks/memory/standalone.test.ts";
const graph = new Map([
  [target, "export const store = 1;"],
  ["src/blocks/memory/index.ts", "export { store } from './store.js';"],
  [
    "tools/memory.ts",
    "export const load = () => import('../src/blocks/memory/index.ts');",
  ],
  [consumer, "import { load } from '../../../tools/memory.ts'; void load;"],
  [standalone, "export {};"],
]);

function select(paths: string[], files = graph) {
  return affectedTests(files, paths);
}

test("a module change reaches tests through re-exports and literal dynamic imports", () => {
  expect(select([target])).toMatchObject({
    files: [consumer],
    count: 1,
    fallback: false,
  });
}, 1000);

test("a changed test selects itself", () => {
  expect(select([standalone])).toMatchObject({
    files: [standalone],
    count: 1,
    fallback: false,
  });
}, 1000);

test("a literal require reaches its relative TypeScript dependency", () => {
  const files = new Map(graph).set(
    standalone,
    "const { store } = require('../../../src/blocks/memory/store.ts'); void store;",
  );
  expect(select([target], files)).toMatchObject({
    files: [standalone, consumer],
    count: 2,
    fallback: false,
  });
}, 1000);

test.each([
  ["package.json", "shared configuration"],
  ["bun.lock", "shared configuration"],
  ["bunfig.toml", "shared configuration"],
  ["tsconfig.team.json", "shared configuration"],
  [".forge/config.yaml", "shared configuration"],
  [".github/workflows/ci.yml", "CI input"],
  ["tools/ci/test-shards.ts", "CI input"],
  ["test/fixtures/owner-approval.ts", "test support"],
  ["test/structure/lib/repo.ts", "test support"],
  ["test/assembly/fixtures/old-adoption-config.yaml", "test support"],
  ["test/script-fixture.ts", "test support"],
  ["src/assembly/docs.json", "non-TypeScript source"],
  ["bin/forge.ts", "outside the graph"],
  ["src/deleted.ts", "outside the graph"],
])(
  "%s opens the full suite",
  (path, rule) => {
    const result = select([path, target]);
    expect(result).toMatchObject({
      files: [standalone, consumer],
      count: 2,
      fallback: true,
    });
    expect(result.reason).toContain(rule);
  },
  1000,
);

test("a source change with no reachable test opens the full suite", () => {
  const unused = "src/unused.ts";
  const result = select([unused], new Map(graph).set(unused, "export {};"));
  expect(result).toMatchObject({
    files: [standalone, consumer],
    count: 2,
    fallback: true,
  });
  expect(result.reason).toContain("empty selection");
}, 1000);

test.each([
  "export const load = (name: string) => import(name);",
  "export const load = (name: string) => require(name);",
  "export const load = () => import('./missing.ts');",
  "export const broken = @;",
])(
  "only tests that reach an opaque node are always selected for %s",
  (text) => {
    const opaque = "src/blocks/memory/opaque.ts";
    const bridge = "src/blocks/memory/bridge.ts";
    const unrelated = "src/unrelated.ts";
    const files = new Map(graph)
      .set(opaque, text)
      .set(bridge, "export * from './opaque.ts';")
      .set(unrelated, "export {};")
      .set(consumer, "import '../../../src/blocks/memory/bridge.ts';");
    expect(select([unrelated], files)).toMatchObject({
      files: [consumer],
      count: 1,
      fallback: false,
      opaque: [opaque],
      alwaysSelected: [consumer],
    });
  },
  1000,
);
