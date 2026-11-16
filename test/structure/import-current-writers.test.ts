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
    symbol,
    stringCondition,
    bodyOf,
    rootSymbol,
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
  const namespaceValue = (
    input: ts.Expression,
    seen = new Set<ts.Node>(),
  ): string => {
    const node = unwrap(input);
    ok(!seen.has(node), `unresolved client namespace ${where(node)}`);
    if (ts.isStringLiteralLike(node)) return node.text;
    const decl = declaration(node);
    ok(
      ts.isIdentifier(node) &&
        decl &&
        ts.isVariableDeclaration(decl) &&
        ts.isVariableDeclarationList(decl.parent) &&
        !!(decl.parent.flags & ts.NodeFlags.Const) &&
        decl.initializer,
      `unresolved client namespace ${where(node)}`,
    );
    return namespaceValue(decl.initializer, new Set(seen).add(node));
  };
  const stableContainer = (name: ts.Identifier) => {
    const target = symbol(name);
    return !nodes.some(
      (node) =>
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          rootSymbol(node.left) === target) ||
        (ts.isCallExpression(node) &&
          node.arguments.some(
            (argument) => symbol(unwrap(argument)) === target,
          )) ||
        (ts.isVariableDeclaration(node) &&
          !!node.initializer &&
          symbol(unwrap(node.initializer)) === target) ||
        (ts.isReturnStatement(node) &&
          !!node.expression &&
          symbol(unwrap(node.expression)) === target),
    );
  };
  const clientNamespaces = (
    input: ts.Expression,
    fields: readonly string[] = [],
    seen = new Set<ts.Node>(),
  ): string[] | undefined => {
    const node = unwrap(input);
    if (ts.isIdentifier(node) && fields.length)
      ok(stableContainer(node), `unresolved client provenance ${where(node)}`);
    if (seen.has(node)) return undefined;
    const next = new Set(seen).add(node);
    const read = (value: ts.Expression, path = fields) =>
      clientNamespaces(value, path, next);
    const merge = (values: (string[] | undefined)[]) =>
      values.some((v) => v === undefined)
        ? undefined
        : values.flatMap((v) => v!);
    if (ts.isAwaitExpression(node)) return read(node.expression);
    if (ts.isPropertyAccessExpression(node))
      return read(node.expression, [node.name.text, ...fields]);
    if (ts.isConditionalExpression(node))
      return merge([read(node.whenTrue), read(node.whenFalse)]);
    if (ts.isObjectLiteralExpression(node) && fields.length) {
      const found: (string[] | undefined)[] = [];
      for (const field of node.properties) {
        if (ts.isSpreadAssignment(field)) found.push(read(field.expression));
        else if (field.name?.getText() === fields[0]) {
          if (ts.isPropertyAssignment(field))
            found.push(read(field.initializer, fields.slice(1)));
          else if (ts.isShorthandPropertyAssignment(field))
            found.push(read(field.name, fields.slice(1)));
          else return undefined;
        }
      }
      return merge(found);
    }
    if (ts.isIdentifier(node)) {
      const decl = declaration(node);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const found = read(decl.initializer);
        if (found?.length)
          ok(
            ts.isVariableDeclarationList(decl.parent) &&
              !!(decl.parent.flags & ts.NodeFlags.Const),
            `unresolved client provenance ${where(node)}`,
          );
        return found;
      }
      if (
        decl &&
        ts.isBindingElement(decl) &&
        ts.isObjectBindingPattern(decl.parent) &&
        ts.isVariableDeclaration(decl.parent.parent)
      ) {
        const variable = decl.parent.parent;
        if (variable.initializer) {
          ok(
            ts.isVariableDeclarationList(variable.parent) &&
              !!(variable.parent.flags & ts.NodeFlags.Const),
            `unresolved client provenance ${where(node)}`,
          );
          return read(variable.initializer, [
            (decl.propertyName ?? decl.name).getText(),
            ...fields,
          ]);
        }
      }
      if (decl && ts.isParameter(decl)) {
        const fn = decl.parent,
          index = fn.parameters.indexOf(decl);
        const incoming = calls.filter(
          (call) => checker.getResolvedSignature(call)?.getDeclaration() === fn,
        );
        if (incoming.length)
          return merge(
            incoming
              .map((call) => call.arguments[index])
              .map((value) => value && read(value)),
          );
      }
    }
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "client"
      ) {
        const signature = checker.getResolvedSignature(node)?.getDeclaration();
        ok(
          !fields.length &&
            signature
              ?.getSourceFile()
              .fileName.endsWith("/src/core/state/index.ts"),
          `unresolved client provenance ${where(node)}`,
        );
        const namespace = node.arguments[0];
        ok(namespace, `unresolved client namespace ${where(node)}`);
        return [namespaceValue(namespace)];
      }
      const decl = declaration(node.expression),
        fn = decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn)))
        return merge(returned(fn).map((value) => read(value)));
    }
    return undefined;
  };
  const unchanged = (
    name: ts.Identifier,
    body: ts.Node,
    allowed?: ts.CallExpression,
  ) => {
    const target = symbol(name);
    return !nodes.some(
      (node) =>
        node.getSourceFile() === body.getSourceFile() &&
        node.pos >= body.pos &&
        node.end <= body.end &&
        ((ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          rootSymbol(node.left) === target) ||
          ((ts.isPrefixUnaryExpression(node) ||
            ts.isPostfixUnaryExpression(node)) &&
            [
              ts.SyntaxKind.PlusPlusToken,
              ts.SyntaxKind.MinusMinusToken,
            ].includes(node.operator) &&
            rootSymbol(node.operand) === target) ||
          (ts.isCallExpression(node) &&
            node !== allowed &&
            ts.isPropertyAccessExpression(node.expression) &&
            rootSymbol(node.expression.expression) === target)),
    );
  };
  const parameterForward = (key: ts.Expression, method: string) => {
    const p = declaration(key),
      body = p && ts.isParameter(p) ? bodyOf(p.parent) : undefined;
    return (
      forwarding(key) === method &&
      p &&
      ts.isParameter(p) &&
      !p.initializer &&
      p.parent.parameters[0] === p &&
      ts.isIdentifier(p.name) &&
      body &&
      unchanged(p.name, body)
    );
  };
  const batchForward = (key: ts.Expression) => {
    const node = unwrap(key);
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "map"
    )
      return false;
    const p = declaration(node.expression.expression),
      callback = node.arguments[0],
      body = p && ts.isParameter(p) ? bodyOf(p.parent) : undefined;
    if (
      forwarding(node.expression.expression) !== "putMany" ||
      !p ||
      !ts.isParameter(p) ||
      p.parent.parameters[0] !== p ||
      !ts.isIdentifier(p.name) ||
      !body ||
      !unchanged(p.name, body, node) ||
      !callback ||
      !ts.isArrowFunction(callback)
    )
      return false;
    const value =
      callback.body && !ts.isBlock(callback.body)
        ? unwrap(callback.body)
        : undefined;
    if (!value || !ts.isObjectLiteralExpression(value)) return false;
    const spread = value.properties[0],
      parameter = callback.parameters[0];
    return (
      !!spread &&
      !!parameter &&
      ts.isIdentifier(parameter.name) &&
      ts.isSpreadAssignment(spread) &&
      symbol(spread.expression) === symbol(parameter.name) &&
      value.properties
        .slice(1)
        .every(
          (property) =>
            ts.isPropertyAssignment(property) &&
            !ts.isComputedPropertyName(property.name) &&
            property.name.getText() !== "key" &&
            property.name.getText() !== '"key"',
        )
    );
  };
  const preservesString = (
    fn: ts.FunctionLikeDeclaration,
    seen = new Set<ts.Node>(),
  ): boolean => {
    if (
      seen.has(fn) ||
      !fn.body ||
      !fn.parameters[0] ||
      !ts.isIdentifier(fn.parameters[0].name)
    )
      return false;
    const p = symbol(fn.parameters[0].name);
    if (!p) return false;
    const read = (input: ts.Expression): boolean => {
      const node = unwrap(input);
      if (symbol(node) === p) return true;
      if (ts.isConditionalExpression(node))
        return read(node.whenTrue) && read(node.whenFalse);
      if (
        ts.isCallExpression(node) &&
        node.arguments.length &&
        symbol(node.arguments[0]!) === p
      ) {
        const d = declaration(node.expression),
          target = d && ts.isVariableDeclaration(d) ? d.initializer : d;
        return (
          !!target &&
          (ts.isArrowFunction(target) || ts.isFunctionDeclaration(target)) &&
          preservesString(target, new Set(seen).add(fn))
        );
      }
      return false;
    };
    if (!ts.isBlock(fn.body)) return read(fn.body);
    const first = fn.body.statements[0];
    return (
      !!first &&
      ts.isIfStatement(first) &&
      stringCondition(first.expression, p) === true &&
      ts.isReturnStatement(first.thenStatement) &&
      !!first.thenStatement.expression &&
      read(first.thenStatement.expression)
    );
  };
  const restForward = (key: ts.Expression, method: string) => {
    if (!ts.isSpreadElement(key)) return false;
    const mapped = unwrap(key.expression);
    if (
      !ts.isCallExpression(mapped) ||
      !ts.isPropertyAccessExpression(mapped.expression) ||
      mapped.expression.name.text !== "map"
    )
      return false;
    const p = declaration(mapped.expression.expression),
      callback = mapped.arguments[0],
      d = callback && declaration(callback),
      fn = d && ts.isVariableDeclaration(d) ? d.initializer : d,
      body = p && ts.isParameter(p) ? bodyOf(p.parent) : undefined;
    return (
      !!p &&
      ts.isParameter(p) &&
      !!p.dotDotDotToken &&
      !p.initializer &&
      !!p.type &&
      ts.isTypeReferenceNode(p.type) &&
      p.type.typeName.getText() === "Parameters" &&
      p.type.typeArguments?.length === 1 &&
      ts.isIndexedAccessTypeNode(p.type.typeArguments[0]!) &&
      p.type.typeArguments[0].indexType.getText() === JSON.stringify(method) &&
      ts.isIdentifier(p.name) &&
      !!body &&
      unchanged(p.name, body, mapped) &&
      !!fn &&
      (ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn)) &&
      preservesString(fn)
    );
  };
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
    if (!["put", "putNext", "putMany", "delete"].includes(method)) continue;
    const signature = checker.getResolvedSignature(call)?.getDeclaration();
    const namespaced = signature?.parameters[0]?.name.getText() === "namespace";
    if (
      method === "delete" &&
      !signature
        ?.getSourceFile()
        .fileName.match(
          /\/src\/(?:ports\/state|core\/state\/index|assembly\/state-client)\.ts$/,
        )
    )
      continue;
    const key = call.arguments[namespaced ? 1 : 0];
    ok(key, where(call));
    if (
      parameterForward(key, method) ||
      (method === "putMany" && batchForward(key)) ||
      restForward(key, method)
    )
      continue;
    const decl = declaration(key);
    if (decl && ts.isBindingElement(decl)) {
      const pattern = decl.parent,
        parameter = pattern.parent,
        fn = ts.isParameter(parameter) ? parameter.parent : undefined;
      ok(
        ts.isArrayBindingPattern(pattern) &&
          pattern.elements[0] === decl &&
          !decl.initializer &&
          !decl.dotDotDotToken &&
          ts.isParameter(parameter) &&
          parameter.dotDotDotToken &&
          ts.isArrowFunction(fn!) &&
          fn.body === call &&
          ts.isPropertyAssignment(fn.parent) &&
          fn.parent.name.getText() === method &&
          !!parameter.type &&
          ts.isTypeReferenceNode(parameter.type) &&
          parameter.type.typeName.getText() === "Parameters" &&
          parameter.type.typeArguments?.length === 1 &&
          ts.isIndexedAccessTypeNode(parameter.type.typeArguments[0]!) &&
          parameter.type.typeArguments[0].indexType.getText() ===
            JSON.stringify(method),
        `unresolved writer key ${where(key)}`,
      );
      continue;
    }
    if (namespaced) {
      const namespace = call.arguments[0];
      ok(namespace);
      let value: string;
      try {
        value = namespaceValue(namespace);
      } catch {
        ok(inBlock(call), `unresolved client namespace ${where(namespace)}`);
        value = "forge/work";
      }
      if (value !== "forge/work") continue;
    } else {
      const values = clientNamespaces(call.expression.expression);
      if (values?.length) {
        if (!values.includes("forge/work")) continue;
      } else
        ok(
          inBlock(call),
          `unresolved client namespace ${where(call.expression.expression)}`,
        );
    }
    if (method === "putMany") batch(key);
    else add(key);
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
    "bound delete",
    "assembly",
    owner,
    'const state = owner.client("forge/work", actor); state.delete(`future-family:${id}`, { expectRevision: 1 });',
    "family",
  ],
  [
    "bound alias",
    "assembly",
    owner,
    'const source = owner.client("forge/work", actor); const state = source; state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "family",
  ],
  [
    "foreign client",
    "assembly",
    owner,
    'const state = owner.client("forge/memory", actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "foreign",
  ],
  [
    "unknown namespace",
    "assembly",
    owner,
    "declare const namespace: string; const state = owner.client(namespace, actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });",
    "namespace",
  ],
  [
    "mutable namespace",
    "assembly",
    owner,
    'let namespace = "forge/memory"; namespace = "forge/work"; const state = owner.client(namespace, actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "namespace",
  ],
  [
    "const namespace alias",
    "assembly",
    owner,
    'const namespace = "forge/work"; const state = owner.client(namespace, actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "family",
  ],
  [
    "client parameter property",
    "assembly",
    owner,
    'function write(options: { state: ReturnType<StateOwner["client"]> }) { options.state.put(`future-family:${id}`, value, { expectRevision: 0 }); } write({state: owner.client("forge/work", actor)});',
    "family",
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
    else if (expected === "foreign") eq(missingFamilies(fixture), []);
    else
      throws(
        () => missingFamilies(fixture),
        new RegExp(`${expected}.*import-writer-fixture\\.ts:\\d+:\\d+`),
      );
  },
  30_000,
);
