import { createHash } from "node:crypto";
import { relative } from "node:path";
import * as ts from "typescript-parser";

export interface WriterSite {
  site: string;
  hash: string;
  families: string[];
  refusal?: string;
}

/**
 * This guard catches accidental unclassified writer families in reviewed code;
 * it does not defend against deliberate obfuscation inside this repository,
 * because every change is reviewed and the converter refuses unknown families at run time.
 */
export function scanWriters(program: ts.Program, root: string): WriterSite[] {
  const writers = ["put", "putNext", "putMany", "delete"];
  const opaqueFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  const local = (file: string) =>
    relative(root, file).replaceAll("\\", "/").startsWith("src/");
  const checker = program.getTypeChecker(),
    result: WriterSite[] = [];
  const family = (key: ts.Node | undefined): string | undefined => {
    if (!key) return;
    if (ts.isStringLiteralLike(key)) return key.text.split(":")[0] || undefined;
    if (ts.isTemplateExpression(key) && key.head.text.includes(":"))
      return key.head.text.split(":")[0] || undefined;
    return;
  };
  const siteOf = (node: ts.Node): WriterSite => ({
    site:
      relative(root, node.getSourceFile().fileName).replaceAll("\\", "/") +
      ":" +
      (node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
        .line +
        1),
    hash: createHash("sha256")
      .update(node.getSourceFile().text.replaceAll("\r\n", "\n"))
      .digest("hex"),
    families: [],
  });
  const refuse = (row: WriterSite) => {
    row.refusal = "literal-only writer required at " + row.site;
  };
  const assignmentPattern = (node: ts.Node): node is ts.AssignmentPattern =>
    (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) &&
    !!ts.findAncestor(node, (part) =>
      (ts.isBinaryExpression(part.parent) &&
        part.parent.left === part &&
        part.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
      (ts.isForOfStatement(part.parent) && part.parent.initializer === part)
        ? true
        : ts.isObjectLiteralExpression(part) ||
            ts.isArrayLiteralExpression(part) ||
            ts.isPropertyAssignment(part) ||
            ts.isSpreadAssignment(part) ||
            ts.isSpreadElement(part)
          ? false
          : "quit",
    );
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit);
    const pattern =
      ts.isObjectBindingPattern(node) ||
      ts.isArrayBindingPattern(node) ||
      assignmentPattern(node);
    const type = pattern
      ? assignmentPattern(node)
        ? checker.getTypeOfAssignmentPattern(node)
        : checker.getTypeAtLocation(node)
      : undefined;
    if (
      type &&
      (type.flags & opaqueFlags ||
        writers.some((name) => type.getProperty(name)))
    ) {
      const row = siteOf(node);
      refuse(row);
      result.push(row);
    }
    if (
      !ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)
    )
      return;
    const method = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
    const receiverType = checker.getTypeAtLocation(node.expression);
    const opaque = !!(receiverType.flags & opaqueFlags);
    const state = ["put", "putNext", "putMany"].some((name) =>
      receiverType.getProperty(name),
    );
    const memberFile = checker
      .getSymbolAtLocation(node)
      ?.valueDeclaration?.getSourceFile().fileName;
    if (
      method
        ? !writers.includes(method) ||
          (method === "delete" &&
            !state &&
            !opaque &&
            !(memberFile && local(memberFile)))
        : !state && !opaque
    )
      return;
    const call =
      ts.isCallExpression(node.parent) && node.parent.expression === node
        ? node.parent
        : undefined;
    const namespaced =
      call &&
      checker
        .getResolvedSignature(call)
        ?.getDeclaration()
        ?.parameters[0]?.name.getText() === "namespace";
    let namespace = namespaced ? call.arguments[0] : undefined;
    const declaration = ts.isIdentifier(node.expression)
      ? checker.getSymbolAtLocation(node.expression)?.valueDeclaration
      : undefined;
    const receiver =
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
        ? declaration.initializer
        : undefined;
    if (
      !namespace &&
      receiver &&
      ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      receiver.expression.name.text === "client"
    )
      namespace = receiver.arguments[0];
    if (
      !(opaque && ts.isElementAccessExpression(node)) &&
      namespace &&
      ts.isStringLiteral(namespace) &&
      namespace.text !== "forge/work"
    )
      return;
    const row = siteOf(call ?? node);
    if (!call || !method || ts.isElementAccessExpression(node)) refuse(row);
    else {
      const key = call.arguments[namespaced ? 1 : 0];
      if (method !== "putMany") {
        const name = family(key);
        if (name) row.families.push(name);
        else refuse(row);
      } else if (key && ts.isArrayLiteralExpression(key)) {
        for (const entry of key.elements) {
          if (
            !ts.isObjectLiteralExpression(entry) ||
            entry.properties.some(
              (p) =>
                (!ts.isPropertyAssignment(p) &&
                  !ts.isShorthandPropertyAssignment(p)) ||
                ts.isComputedPropertyName(p.name),
            )
          ) {
            refuse(row);
            continue;
          }
          const keys = entry.properties.filter(
            (p) =>
              p.name?.getText().replaceAll('"', "").replaceAll("'", "") ===
              "key",
          );
          const name =
            keys.length === 1 && ts.isPropertyAssignment(keys[0]!)
              ? family(keys[0].initializer)
              : undefined;
          if (name) row.families.push(name);
          else refuse(row);
        }
      } else refuse(row);
    }
    result.push(row);
  };
  for (const source of program.getSourceFiles())
    if (local(source.fileName)) visit(source);
  return result;
}
