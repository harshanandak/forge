import { test } from "bun:test";
import { deepStrictEqual as eq, ok } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as ts from "typescript-parser";
import * as converter from "../../tools/import-current-state.ts";

const root = resolve(import.meta.dirname, "../..");
const files = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(path, entry.name))
      : /\.(?:[cm]?ts|json)$/.test(entry.name)
        ? [join(path, entry.name).replaceAll("\\", "/")]
        : [],
  );
const paths = files(join(root, "src"));
const blocks = paths.filter(
  (path) =>
    path.endsWith("forge.block.json") &&
    (JSON.parse(readFileSync(path, "utf8")) as { id: string }).id ===
      "forge/work",
);
const program = ts.createProgram(
  paths.filter((path) => /\.[cm]?ts$/.test(path)),
  { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext },
);
const checker = program.getTypeChecker();
const nodes: ts.Node[] = [];
for (const source of program.getSourceFiles())
  if (paths.includes(source.fileName)) {
    const visit = (node: ts.Node) => {
      nodes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
const calls = nodes.filter(ts.isCallExpression);
const symbols = (node: ts.Node) => {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
};
const where = (node: ts.Node) => {
  const source = node.getSourceFile();
  return `${relative(root, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
};
const returns = (node: ts.FunctionLikeDeclaration): ts.Expression[] => {
  if (!node.body) return [];
  if (!ts.isBlock(node.body)) return [node.body];
  const found: ts.Expression[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isReturnStatement(child) && child.expression)
      found.push(child.expression);
    else if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit);
  };
  ts.forEachChild(node.body, visit);
  return found;
};
type Bindings = Map<ts.Symbol, ts.Expression>;
function examples(
  node: ts.Expression,
  bound: Bindings = new Map(),
  seen = new Set<ts.Node>(),
): string[] {
  ok(!seen.has(node), `recursive key builder at ${where(node)}`);
  const next = new Set(seen).add(node);
  const read = (value: ts.Expression) => examples(value, bound, next);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    return [node.text];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return read(node.expression);
  if (ts.isTemplateExpression(node)) {
    let keys = [node.head.text];
    for (const span of node.templateSpans) {
      let values: string[];
      try {
        values = read(span.expression);
      } catch {
        // A dynamic suffix cannot introduce a new family; the literal head must name it.
        ok(
          keys.every((key) => /^[a-z][a-z-]*:/.test(key)),
          where(node),
        );
        const text = span.expression.getText();
        values = [
          /JSON\.stringify/.test(text)
            ? JSON.stringify(["https://fixture.invalid", "fixture", "fixture"])
            : /(?:length|count|sequence|\.pr)/i.test(text)
              ? "1"
              : /attempt/i.test(text)
                ? "attempt-1"
                : "work-1",
        ];
      }
      if (!values.length) values = ["attempt:work-1:attempt-1"];
      keys = keys.flatMap((key) =>
        values.map((value) => key + value + span.literal.text),
      );
    }
    return keys;
  }
  if (ts.isConditionalExpression(node))
    return [...read(node.whenTrue), ...read(node.whenFalse)];
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  )
    return read(node.left).flatMap((left) =>
      read(node.right).map((right) => left + right),
    );
  if (ts.isPropertyAccessExpression(node) && node.name.text === "key")
    return []; // Rewriting an existing record's key creates no new family.
  if (ts.isIdentifier(node)) {
    const symbol = symbols(node);
    const argument = symbol && bound.get(symbol);
    if (argument) return read(argument);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration)) {
      ok(declaration.initializer, where(node));
      return read(declaration.initializer);
    }
    if (declaration && ts.isParameter(declaration)) {
      const fn = declaration.parent;
      const index = fn.parameters.indexOf(declaration);
      const name = fn.name;
      ok(name, `unnamed writer forwarding at ${where(node)}`);
      const incoming = calls.filter(
        (call) => symbols(call.expression) === symbols(name),
      );
      ok(incoming.length, `unresolved writer parameter at ${where(node)}`);
      return incoming.flatMap((call) => {
        const value = call.arguments[index];
        ok(value, where(call));
        return read(value);
      });
    }
  }
  if (ts.isCallExpression(node)) {
    const declaration = symbols(node.expression)?.valueDeclaration;
    const fn =
      declaration && ts.isVariableDeclaration(declaration)
        ? declaration.initializer
        : declaration;
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn))) {
      const bindings = new Map(bound);
      fn.parameters.forEach((parameter, index) => {
        const symbol = symbols(parameter.name),
          value = node.arguments[index];
        if (symbol && value) bindings.set(symbol, value);
      });
      return returns(fn).flatMap((value) => examples(value, bindings, next));
    }
  }
  throw new Error(`unresolved writer key at ${where(node)}: ${node.getText()}`);
}

function missingFamilies(extra: ts.CallExpression[] = []) {
  eq(blocks.length, 1);
  const sources = new Map<string, string>();
  const add = (
    expression: ts.Expression,
    append = false,
    bindings?: Bindings,
  ) => {
    for (let key of examples(expression, bindings)) {
      if (append) key += "1";
      sources.set(key, where(expression));
    }
  };
  const floors = nodes.filter(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      node.name.getText() === "floorKey" &&
      node.getSourceFile().fileName.endsWith("/src/core/state/index.ts"),
  );
  ok(
    floors.length,
    "state owner's generated floor builders must be discovered",
  );
  for (const call of calls.concat(extra)) {
    const source = call.getSourceFile();
    const inBlock = blocks.some((path) =>
      source.fileName.startsWith(dirname(path) + "/"),
    );
    if (!ts.isPropertyAccessExpression(call.expression)) continue;
    const method = call.expression.name.text;
    if (!["put", "putNext"].includes(method)) continue;
    let key = call.arguments[0];
    ok(key, where(call));
    if (!inBlock) {
      if (call.arguments.length < 4) continue;
      let namespaces: string[];
      try {
        namespaces = examples(key);
      } catch {
        ok(
          !source.text.includes('"forge/work"'),
          `unresolved work namespace at ${where(call)}`,
        );
        continue;
      }
      if (!namespaces.includes("forge/work")) continue;
      key = call.arguments[1];
      ok(key, where(call));
    }
    // The rest-tuple adapter forwards the exact key supplied by other scanned writers.
    const declaration = ts.isIdentifier(key)
      ? symbols(key)?.valueDeclaration
      : undefined;
    if (declaration && ts.isBindingElement(declaration)) continue;
    add(key, method === "putNext");
    if (method === "putNext")
      for (const floor of floors) {
        const expression = floor.initializer;
        ok(expression && ts.isTemplateExpression(expression));
        const prefix = expression.templateSpans[0]?.expression;
        const symbol = prefix && symbols(prefix);
        ok(symbol, "floor builder prefix must resolve");
        add(expression, false, new Map([[symbol, key]]));
      }
  }
  for (const node of nodes)
    if (
      blocks.some((path) =>
        node.getSourceFile().fileName.startsWith(dirname(path) + "/"),
      ) &&
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "key" &&
      ts.isObjectLiteralExpression(node.parent) &&
      node.parent.properties.some(
        (property) => property.name?.getText() === "value",
      )
    )
      add(node.initializer);
  const leftBehind = (
    converter as unknown as {
      leftBehindKey?: (namespace: string, key: string) => boolean;
    }
  ).leftBehindKey;
  const missing = [...sources].filter(
    ([key]) =>
      !converter.ordinaryKey("forge/work", key) &&
      !leftBehind?.("forge/work", key),
  );
  ok(sources.size, "source writer discovery must not be empty");
  return missing;
}

test("every source work writer family has an explicit import disposition", () => {
  const missing = missingFamilies();
  eq(
    missing,
    [],
    `unclassified forge/work families: ${JSON.stringify(missing)}`,
  );
}, 30_000);

test("a newly introduced work writer fails the classification guard", () => {
  const source = ts.createSourceFile(
    join(dirname(blocks[0]!), "future.cts").replaceAll("\\", "/"),
    "state.put(`future-family:${id}`, {}, { expectRevision: 0 });",
    ts.ScriptTarget.ESNext,
    true,
  );
  const expression = (source.statements[0] as ts.ExpressionStatement)
    .expression;
  ok(ts.isCallExpression(expression));
  ok(
    missingFamilies([expression]).some(([key]) =>
      key.startsWith("future-family:"),
    ),
  );
}, 30_000);
