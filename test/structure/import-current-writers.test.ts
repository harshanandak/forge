import { test } from "bun:test";
import { deepStrictEqual as eq, ok, throws } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as ts from "typescript-parser";
import * as converter from "../../tools/import-current-state.ts";
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
const checker = program.getTypeChecker();
const walk = (node: ts.Node): ts.Node[] => {
  const found = [node];
  ts.forEachChild(node, (child) => {
    found.push(...walk(child));
  });
  return found;
};
const nodes = program
  .getSourceFiles()
  .filter((s) => paths.includes(s.fileName))
  .flatMap(walk);
const calls = nodes.filter(ts.isCallExpression);
const where = (node: ts.Node) => `${node.getSourceFile().fileName}:${node.pos}`;
const symbol = (node: ts.Node) => {
  const found = checker.getSymbolAtLocation(node);
  return found && found.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(found)
    : found;
};
const declaration = (node: ts.Node) => symbol(node)?.valueDeclaration;
const forwarding = (key: ts.Expression) => {
  const p = declaration(key);
  if (!p || !ts.isParameter(p)) return;
  const fn = p.parent;
  return ts.isMethodDeclaration(fn)
    ? fn.name.getText()
    : ts.isArrowFunction(fn) && ts.isPropertyAssignment(fn.parent)
      ? fn.parent.name.getText()
      : undefined;
};
const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node;
const returned = (fn: ts.FunctionLikeDeclaration): ts.Expression[] => {
  ok(fn.body, where(fn));
  return ts.isBlock(fn.body)
    ? walk(fn.body)
        .filter(ts.isReturnStatement)
        .flatMap((n) => (n.expression ? [n.expression] : []))
    : [fn.body];
};
function examples(input: ts.Expression, seen = new Set<ts.Node>()): string[] {
  const node = unwrap(input);
  ok(!seen.has(node), `recursive key builder ${where(node)}`);
  const next = new Set(seen).add(node);
  const read = (value: ts.Expression) => examples(value, next);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    return [node.text];
  if (ts.isTemplateExpression(node)) {
    let keys = [node.head.text];
    for (const span of node.templateSpans) {
      if (keys.every((key) => key.includes(":"))) return keys;
      const values = read(span.expression);
      keys = keys.flatMap((key) =>
        values.map((value) => key + value + span.literal.text),
      );
    }
    return keys;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = read(node.left);
    if (left.every((key) => key.includes(":"))) return left;
    const right = read(node.right);
    return left.flatMap((a) => right.map((b) => a + b));
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "key") {
    const fields =
      checker.getTypeAtLocation(node.expression).getProperty("key")
        ?.declarations ?? [];
    ok(
      fields.some(
        (field) =>
          ts.isInterfaceDeclaration(field.parent) &&
          field.parent.name.text === "StateRecord" &&
          field.getSourceFile().fileName.endsWith("/src/generated/types.ts"),
      ),
      `opaque work key ${where(node)}`,
    );
    return [];
  }
  if (ts.isIdentifier(node)) {
    const decl = declaration(node);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
      return read(decl.initializer);
    if (decl && ts.isParameter(decl)) {
      const fn = decl.parent,
        index = fn.parameters.indexOf(decl);
      ok(fn.name, where(node));
      const incoming = calls.filter(
        (call) => symbol(call.expression) === symbol(fn.name!),
      );
      ok(incoming.length, `unresolved writer parameter ${where(node)}`);
      return incoming.flatMap((call) => {
        const value = call.arguments[index];
        ok(value);
        return read(value);
      });
    }
  }
  if (ts.isCallExpression(node)) {
    const decl = declaration(node.expression);
    const fn = decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn))) {
      return returned(fn).flatMap(read);
    }
  }
  throw new Error(`unresolved writer key ${where(node)}: ${node.getText()}`);
}
function missingFamilies(extra: ts.CallExpression[] = []) {
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
  for (const call of calls.concat(extra)) {
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
test("new work families and opaque batches fail the source guard", () => {
  const call = (text: string) => {
    const source = ts.createSourceFile(
      join(dirname(blocks[0]!), "future.cts").replaceAll("\\", "/"),
      text,
      ts.ScriptTarget.ESNext,
      true,
    );
    const expression = (source.statements[0] as ts.ExpressionStatement)
      .expression;
    ok(ts.isCallExpression(expression));
    return expression;
  };
  ok(
    missingFamilies([call("state.put(`future-family:${id}`, {}, {});")]).some(
      ([family]) => family === "future-family",
    ),
  );
  for (const text of [
    "state.putMany(input.entries, {});",
    "state.put(input.key, {}, {});",
  ])
    throws(() => missingFamilies([call(text)]), /opaque work/);
}, 30_000);
