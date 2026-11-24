import { API } from "typescript/unstable/async";
import * as ast from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { isTestFile, repoRoot } from "./repo.ts";
import type { SourceFile, Violation } from "./repo.ts";

const { SyntaxKind: Kind, NodeFlags, ModifierFlags } = ast;
const inertValues = new Set([
  Kind.Identifier,
  Kind.TrueKeyword,
  Kind.FalseKeyword,
  Kind.NullKeyword,
  Kind.ArrowFunction,
  Kind.FunctionExpression,
  Kind.OmittedExpression,
  Kind.DotDotDotToken,
  Kind.TemplateHead,
]);
const wrappers = new Set([
  Kind.AsExpression,
  Kind.SatisfiesExpression,
  Kind.NonNullExpression,
  Kind.ParenthesizedExpression,
  Kind.SpreadElement,
  Kind.TypeOfExpression,
  Kind.VoidExpression,
  Kind.ComputedPropertyName,
  Kind.TemplateSpan,
  Kind.SpreadAssignment,
]);
const updates = new Set([Kind.PlusPlusToken, Kind.MinusMinusToken]);
const containers = new Set([
  Kind.ArrayLiteralExpression,
  Kind.ObjectLiteralExpression,
  Kind.PropertyAssignment,
  Kind.BindingElement,
  Kind.TemplateExpression,
]);
const inertStatements = new Set([
  Kind.ImportDeclaration,
  Kind.ExportDeclaration,
  Kind.TypeAliasDeclaration,
  Kind.InterfaceDeclaration,
  Kind.FunctionDeclaration,
]);

export function isHubSource(path: string): boolean {
  return /^hub\/src\/.*\.ts$/.test(path) && !isTestFile(path);
}

const declare = (node: ast.Node) =>
  node.kind === Kind.DeclareKeyword || undefined;
const isAmbient = (node: ast.Statement) =>
  Boolean(node.flags & NodeFlags.Ambient || node.forEachChild(declare));

function variables(node: ast.Statement) {
  if (!ast.isVariableStatement(node)) return;
  if (node.declarationList.flags & (NodeFlags.Const | NodeFlags.Let))
    return node.declarationList.declarations;
}

function bindingsIn(source: ast.SourceFile): Set<string> {
  const bindings = new Set<string>();
  function add(name?: ast.BindingName): void {
    if (!name) return;
    if (ast.isIdentifier(name)) bindings.add(name.text);
    else for (const element of name.elements) add(element.name);
  }
  for (const node of source.statements) {
    if (isAmbient(node)) continue;
    if (ast.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause || clause.phaseModifier === Kind.TypeKeyword) continue;
      add(clause.name);
      const named = clause.namedBindings;
      if (named && ast.isNamespaceImport(named)) add(named.name);
      else
        for (const specifier of named?.elements ?? [])
          if (!specifier.isTypeOnly) add(specifier.name);
    } else if (
      ast.isFunctionDeclaration(node) ||
      ast.isClassDeclaration(node) ||
      ast.isEnumDeclaration(node)
    ) {
      add(node.name);
    } else for (const variable of variables(node) ?? []) add(variable.name);
  }
  return bindings;
}

function violationsIn(source: ast.SourceFile, file: string): Violation[] {
  const bindings = bindingsIn(source);
  function memberPart(node: ast.Node): ast.Node | undefined {
    if (ast.isDecorator(node)) return node;
    if (ast.isComputedPropertyName(node)) return expression(node.expression);
    if (ast.isParameterDeclaration(node))
      return node.modifiers?.find(ast.isDecorator);
  }
  function classPart(node: ast.Node): ast.Node | undefined {
    if (ast.isDecorator(node) || ast.isClassStaticBlockDeclaration(node))
      return node;
    if (ast.isHeritageClause(node) && node.token === Kind.ExtendsKeyword) {
      for (const base of node.types) {
        const problem = expression(base.expression);
        if (problem) return problem;
      }
    }
    const part = node.forEachChild(memberPart);
    if (part) return part;
    if (
      ast.isPropertyDeclaration(node) &&
      node.modifierFlags & ModifierFlags.Static
    )
      return expression(node.initializer);
  }
  function expression(node?: ast.Node): ast.Node | undefined {
    if (!node || inertValues.has(node.kind) || ast.isLiteralExpression(node))
      return;
    if (wrappers.has(node.kind))
      return expression(node.forEachChild((child) => child));
    if (containers.has(node.kind) || ast.isBindingPattern(node))
      return node.forEachChild(expression);
    if (ast.isClassExpression(node)) return node.forEachChild(classPart);
    if (ast.isFunctionLikeDeclaration(node))
      return node.forEachChild(memberPart);
    if (ast.isShorthandPropertyAssignment(node))
      return expression(node.objectAssignmentInitializer);
    if (ast.isPropertyAccessExpression(node)) {
      const target = node.expression;
      const plain = !node.questionDotToken && ast.isIdentifier(node.name);
      const bound = ast.isIdentifier(target) && bindings.has(target.text);
      return plain && bound ? undefined : node;
    }
    if (ast.isPrefixUnaryExpression(node))
      return updates.has(node.operator) ? node : expression(node.operand);
    if (ast.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      return ast.isAssignmentOperator(operator)
        ? node
        : (expression(node.left) ?? expression(node.right));
    }
    return node;
  }
  function enumMember(node: ast.Node): ast.Node | undefined {
    if (!ast.isEnumMember(node)) return;
    if (ast.isComputedPropertyName(node.name)) return node.name;
    const value = node.initializer;
    if (value && !ast.isStringLiteral(value) && !ast.isNumericLiteral(value))
      return value;
  }
  function statementProblem(node: ast.Statement): ast.Node | undefined {
    if (inertStatements.has(node.kind) || isAmbient(node)) return;
    if (ast.isClassDeclaration(node)) return node.forEachChild(classPart);
    if (ast.isExportAssignment(node))
      return node.isExportEquals ? node : expression(node.expression);
    if (ast.isEnumDeclaration(node)) return node.forEachChild(enumMember);
    const declarations = variables(node);
    if (!declarations) return node;
    for (const declaration of declarations) {
      const problem =
        expression(declaration.name) ?? expression(declaration.initializer);
      if (problem) return problem;
    }
  }
  const result: Violation[] = [];
  for (const statement of source.statements) {
    const problem = statementProblem(statement);
    if (!problem) continue;
    const start = problem.getStart(source);
    const { line } = source.getLineAndCharacterOfPosition(start);
    result.push({
      rule: "hub-import-purity",
      file,
      line: line + 1,
      message: `${Kind[problem.kind]} at module scope`,
    });
  }
  return result;
}

export async function findHubImportPurityViolations(
  files: readonly SourceFile[],
): Promise<Violation[]> {
  if (!files.length) return [];
  const cwd = repoRoot.replaceAll("\\", "/");
  const prefix = `${cwd}.hub-import-purity/`;
  const config = prefix + "tsconfig.json";
  const sources = files.map(({ path, text }) => [prefix + path, text] as const);
  const projectConfig = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, types: [] },
    files: sources.map(([path]) => path),
  });
  const fs = createVirtualFileSystem(
    Object.fromEntries([...sources, [config, projectConfig]]),
  );
  const api = new API({ cwd, fs });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    const program = snapshot.getProject(config)?.program;
    if (!program) throw new Error("Missing hub purity parser project");
    const [invalid] = await program.getSyntacticDiagnostics();
    if (invalid) throw new Error(`Invalid source in ${invalid.fileName}`);
    const result: Violation[] = [];
    for (const { path } of files) {
      const source = await program.getSourceFile(prefix + path);
      if (!source) throw new Error(`Hub purity parser could not read ${path}`);
      result.push(...violationsIn(source, path));
    }
    return result;
  } finally {
    await api.close();
  }
}
