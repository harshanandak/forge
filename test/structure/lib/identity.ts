import { posix, resolve } from "node:path";
import {
  isCallExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNamedExports,
  isNamedImports,
  isStringLiteral,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { importsOf } from "./imports.ts";
import type { SourceFile, Violation } from "./repo.ts";
import { isTestFile } from "./repo.ts";

// Predicate-only imports expose no minting capability.
const predicateOnly =
  /^[ \t]*(?:import|export)\s*\{\s*isVerifiedIdentity(?:\s+as\s+\w+)?\s*\}\s*from\s*["'][^"']+["']\s*;?/gm;

function mintTarget(path: string, specifier: string): boolean {
  return /^src\/ports\/identity-mint\.(?:ts|js)$/.test(
    posix.normalize(
      posix.join(posix.dirname(path), specifier.replaceAll("\\", "/")),
    ),
  );
}

const boundaries = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
]);

function reexportsMint(file: SourceFile): boolean {
  const name = /\.[jt]sx$/.test(file.path) ? "input.tsx" : "input.ts";
  const input = resolve(".identity-provenance", name).replaceAll("\\", "/");
  const config = posix.join(posix.dirname(input), "tsconfig.json");
  const fs = createVirtualFileSystem({
    [input]: file.text,
    [config]: JSON.stringify({
      compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
      files: [name],
    }),
  });
  const api = new API({ fs });
  try {
    using snapshot = api.updateSnapshot({ openProjects: [config] });
    const program = snapshot.getProject(config)?.program;
    const tree = program?.getSourceFile(input);
    if (!program || !tree || program.getSyntacticDiagnostics(input).length)
      return true;
    const oauth = file.path === "cloud/src/adapters/workers-oauth/index.ts";
    const bindings = new Set<string>();
    let mintImports = 0;
    const loads = (node: Node): boolean => {
      if (isImportEqualsDeclaration(node)) return true;
      if (isImportDeclaration(node) || isExportDeclaration(node)) {
        const target = node.moduleSpecifier;
        if (target && !isStringLiteral(target)) return true;
        if (
          target &&
          isStringLiteral(target) &&
          mintTarget(file.path, target.text)
        ) {
          if (isExportDeclaration(node))
            return (
              oauth ||
              !node.exportClause ||
              !isNamedExports(node.exportClause) ||
              node.exportClause.elements.some(
                (e) => (e.propertyName ?? e.name).text !== "isVerifiedIdentity",
              )
            );
          mintImports++;
          if (
            oauth &&
            (mintImports !== 1 ||
              node.getText(tree) !==
                'import { mintIdentity } from "../../../../src/ports/identity-mint.ts";')
          )
            return true;
          const clause = node.importClause;
          const names = clause?.namedBindings;
          if (!clause || clause.name || !names || !isNamedImports(names))
            return true;
          for (const entry of names.elements) {
            const name = (entry.propertyName ?? entry.name).text;
            if (name === "mintIdentity") bindings.add(entry.name.text);
            else if (name !== "isVerifiedIdentity") return true;
          }
        }
        return false;
      }
      if (
        isCallExpression(node) &&
        (node.expression.kind === SyntaxKind.ImportKeyword ||
          (isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const target = node.arguments[0];
        if (
          !target ||
          !isStringLiteral(target) ||
          mintTarget(file.path, target.text)
        )
          return true;
      }
      if (
        isIdentifier(node) &&
        node.text === "require" &&
        (!isCallExpression(node.parent) || node.parent.expression !== node)
      )
        return true;
      return node.forEachChild(loads) === true;
    };
    if (loads(tree)) return true;
    const scopes: Node[] = [];
    const references = (node: Node): boolean => {
      if (isImportDeclaration(node)) return false;
      if (isIdentifier(node) && bindings.has(node.text)) {
        if (!isCallExpression(node.parent) || node.parent.expression !== node)
          return true;
        if (oauth) {
          const [factory, verifier] = scopes;
          if (
            scopes.length !== 2 ||
            !factory ||
            !verifier ||
            !isFunctionDeclaration(factory) ||
            factory.name?.text !== "createOAuthAdapter" ||
            !isFunctionDeclaration(verifier) ||
            verifier.name?.text !== "verifyProviderToken"
          )
            return true;
        }
      }
      const boundary = boundaries.has(node.kind);
      if (boundary) scopes.push(node);
      const refused = node.forEachChild(references) === true;
      if (boundary) scopes.pop();
      return refused;
    };
    return references(tree);
  } catch {
    // An unavailable parser or an unclassifiable tree never grants mint authority.
    return true;
  } finally {
    api.close();
  }
}

export function findIdentityMintViolations(
  files: readonly SourceFile[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const path = posix.normalize(file.path.replaceAll("\\", "/"));
    const source = { path, text: file.text };
    if (path !== "cloud/src/adapters/workers-oauth/index.ts")
      source.text = source.text.replace(predicateOnly, "");
    const verifier =
      (path.startsWith("src/adapters/oidc/") && !isTestFile(path)) ||
      path === "src/adapters/oidc/identity-mint.test.ts" ||
      path === "cloud/src/adapters/workers-oauth/index.ts" ||
      path === "test/contract/lib/identity-verifier.ts";
    if (
      verifier
        ? reexportsMint(source)
        : importsOf(source).some((specifier) => mintTarget(path, specifier))
    )
      violations.push({
        rule: "identity-provenance",
        file: file.path,
        message:
          "identity-mint may be imported only by verifiers and never re-exported",
      });
  }
  return violations;
}
