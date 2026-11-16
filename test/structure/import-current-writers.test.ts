import { test } from "bun:test";
import { deepStrictEqual as eq, ok, throws } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as ts from "typescript-parser";
import * as converter from "../../tools/import-current-state.ts";
import { writerSyntax } from "../../tools/import-writer-scan.ts";
const root = resolve(import.meta.dirname, "../../src");
const paths = readdirSync(root, { recursive: true, encoding: "utf8" }).map(
  (p) => join(root, p).replaceAll("\\", "/"),
);
const blocks = paths.filter(
  (p) =>
    p.endsWith("forge.block.json") &&
    (JSON.parse(readFileSync(p, "utf8")) as { id: string }).id === "forge/work",
);
const program = ts.createProgram(
  paths.filter((p) => /\.[cm]?ts$/.test(p)),
  {},
);
type Fixture = { file: string; text: string };
function missingFamilies(fixture?: Fixture) {
  const path = fixture && join(root, fixture.file).replaceAll("\\", "/");
  const host = ts.createCompilerHost({}),
    original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, version, error, fresh) =>
    file === path
      ? ts.createSourceFile(file, fixture!.text, version, true)
      : (program.getSourceFile(file) ?? original(file, version, error, fresh));
  const files = path ? paths.concat(path) : paths;
  const bound = path
    ? ts.createProgram(
        files.filter((p) => /\.[cm]?ts$/.test(p)),
        {},
        host,
        program,
      )
    : program;
  const {
    checker,
    nodes,
    calls,
    where,
    declaration,
    forwarding,
    unwrap,
    returned,
    examples,
  } = writerSyntax(bound, files);
  eq(blocks.length, 1);
  const workDir = dirname(blocks[0]!) + "/";
  const owned = new Set(paths.filter((p) => p.startsWith(workDir)));
  for (let before = -1; before !== owned.size;) {
    before = owned.size;
    for (const call of calls) {
      if (!owned.has(call.getSourceFile().fileName)) continue;
      const fn = declaration(call.expression);
      if (
        fn &&
        ts.isMethodDeclaration(fn) &&
        fn.parameters[0]?.name.getText() === "namespace"
      )
        continue;
      const target = fn?.getSourceFile();
      if (target && paths.includes(target.fileName)) owned.add(target.fileName);
    }
  }
  const inBlock = (node: ts.Node) =>
    owned.has(node.getSourceFile().fileName) ||
    node.getSourceFile().fileName.startsWith(workDir);
  const sources = new Map<string, string>();
  const add = (expression: ts.Expression) => {
    for (const key of examples(expression))
      sources.set(key.split(":")[0]!, where(expression));
  };
  const batch = (input: ts.Expression, seen = new Set<ts.Node>()): void => {
    const node = unwrap(input);
    ok(!seen.has(node), `recursive batch ${where(node)}`);
    const next = new Set(seen).add(node),
      read = (value: ts.Expression) => batch(value, next);
    const decl = declaration(node);
    if (
      ts.isIdentifier(node) &&
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer
    )
      return read(decl.initializer);
    if (ts.isArrayLiteralExpression(node)) {
      for (const entry of node.elements)
        read(ts.isSpreadElement(entry) ? entry.expression : entry);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map"
    ) {
      const fn = node.arguments[0];
      ok(fn && ts.isArrowFunction(fn), `opaque batch map ${where(node)}`);
      for (const value of returned(fn)) read(value);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment);
      const key = properties.find((p) => p.name.getText() === "key");
      ok(
        key && properties.some((p) => p.name.getText() === "value"),
        `opaque batch entry ${where(node)}`,
      );
      add(key.initializer);
      return;
    }
    throw new Error(`opaque work batch ${where(node)}`);
  };
  const floors = nodes.filter(
    (n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) &&
      n.name.getText() === "floorKey" &&
      n.getSourceFile().fileName.endsWith("/src/core/state/index.ts"),
  );
  ok(floors.length, "generated allocation builders must be discovered");
  for (const floor of floors) {
    ok(floor.initializer);
    add(floor.initializer);
  }
  for (const call of calls) {
    if (!ts.isPropertyAccessExpression(call.expression)) continue;
    const method = call.expression.name.text;
    if (!["put", "putNext", "putMany"].includes(method)) continue;
    let key = call.arguments[0];
    ok(key, where(call));
    const signature = checker.getResolvedSignature(call)?.getDeclaration();
    if (
      signature?.parameters[0]?.name.getText() === "namespace" ||
      !inBlock(call)
    ) {
      if (call.arguments.length < (method === "putMany" ? 2 : 4)) continue;
      let namespaces: string[];
      try {
        namespaces = examples(key);
      } catch {
        if (inBlock(call) && method !== "putMany") {
          const value = call.arguments[1];
          if (value && forwarding(value) === method) continue;
          ok(value);
          add(value);
          continue;
        }
        ok(
          !call.getSourceFile().text.includes('"forge/work"'),
          `unresolved work namespace ${where(call)}`,
        );
        continue;
      }
      if (!namespaces.includes("forge/work")) continue;
      key = call.arguments[1];
      ok(key);
    }
    if (forwarding(key) === method) continue;
    if (method === "putMany") {
      batch(key);
      continue;
    }
    const decl = declaration(key);
    if (decl && ts.isBindingElement(decl)) continue; // Rest-tuple forwarding retains other writers' exact keys.
    add(key);
  }
  for (const node of nodes)
    if (
      inBlock(node) &&
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "entries"
    )
      batch(node.initializer);
  ok(sources.size, "writer discovery must not be empty");
  return [...sources].filter(([family]) => !converter.classifiedFamily(family));
}
test("every source work writer family has an explicit import disposition", () => {
  eq(missingFamilies(), []);
}, 30_000);
const work =
  'import type { LeaseStateClient } from "../../assembly/state-client.ts"; declare const state: LeaseStateClient; declare const id: string; declare const value: unknown; declare const input: { key: string; entries: readonly { key: string; value: unknown; expectRevision: number }[] };';
const owner =
  'import type { StateOwner } from "../core/state/index.ts"; import type { Actor } from "../generated/types.ts"; declare const owner: StateOwner; declare const actor: Actor; declare const id: string; declare const value: unknown;';
test.each([
  [
    "direct family",
    "blocks/work",
    work,
    "state.put(`future-family:${id}`, value, { expectRevision: 0 });",
    "family",
  ],
  [
    "opaque batch",
    "blocks/work",
    work,
    "state.putMany(input.entries, {});",
    "opaque",
  ],
  [
    "opaque key",
    "blocks/work",
    work,
    "state.put(input.key, value, { expectRevision: 0 });",
    "opaque",
  ],
  [
    "destructured key",
    "blocks/work",
    work,
    "const { key } = { key: `future-family:${id}` }; state.put(key, value, { expectRevision: 0 });",
    "unresolved",
  ],
  [
    "namespace-bound client",
    "assembly",
    owner,
    'const state = owner.client("forge/work", actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "family",
  ],
])(
  "checker-bound source rejects %s",
  (_name, folder, prelude, body, expected) => {
    const fixture = {
      file: `${folder}/import-writer-fixture.ts`,
      text: prelude + body,
    };
    if (expected === "family")
      ok(
        missingFamilies(fixture).some(([family]) => family === "future-family"),
      );
    else
      throws(
        () => missingFamilies(fixture),
        new RegExp(`${expected}.*import-writer-fixture\\.ts:\\d+:\\d+`),
      );
  },
  30_000,
);
