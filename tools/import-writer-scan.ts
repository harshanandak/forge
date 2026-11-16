import { ok } from "node:assert/strict";
import * as ts from "typescript-parser";

export function writerSyntax(program: ts.Program, paths: readonly string[]) {
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
  const where = (node: ts.Node) => {
    const source = node.getSourceFile(),
      at = source.getLineAndCharacterOfPosition(node.getStart());
    return `${source.fileName}:${at.line + 1}:${at.character + 1}`;
  };
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
      const fn =
        decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn))) {
        return returned(fn).flatMap(read);
      }
    }
    throw new Error(`unresolved writer key ${where(node)}: ${node.getText()}`);
  }

  const bodyOf = (node: ts.Node) =>
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
      ? node.body
      : undefined;
  const rootSymbol = (input: ts.Expression) => {
    let node = unwrap(input);
    while (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    )
      node = node.expression;
    return symbol(node);
  };
  const constantString = Symbol("string argument");
  const stringCondition = (
    input: ts.Expression,
    parameter: ts.Symbol,
  ): unknown => {
    const node = unwrap(input);
    if (symbol(node) === parameter) return constantString;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isTypeOfExpression(node) && symbol(node.expression) === parameter)
      return "string";
    if (!ts.isBinaryExpression(node)) return undefined;
    const a = stringCondition(node.left, parameter),
      b = stringCondition(node.right, parameter),
      op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken)
      return a === true || b === true
        ? true
        : a === false && b === false
          ? false
          : undefined;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken)
      return a === false || b === false
        ? false
        : a === true && b === true
          ? true
          : undefined;
    if (a === undefined || b === undefined) return undefined;
    if (a === constantString || b === constantString) return undefined;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return a === b;
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return a !== b;
    return undefined;
  };
  return {
    rootSymbol,
    bodyOf,
    stringCondition,
    checker,
    nodes,
    calls,
    where,
    symbol,
    declaration,
    forwarding,
    unwrap,
    returned,
    examples,
  };
}
