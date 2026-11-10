import { posix } from "node:path";
import { importsOf, parsedSource } from "./imports.ts";
import { maskSource } from "./platform.ts";
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

function reexportsMint(file: SourceFile): boolean {
  if (!importsOf(file).some((s) => mintTarget(file.path, s))) return false;
  if (file.path === "cloud/src/adapters/workers-oauth/index.ts") {
    const text = file.text.replace(
      'import { mintIdentity } from "../../../../src/ports/identity-mint.ts";',
      "",
    );
    if (
      text === file.text ||
      importsOf({ ...file, text }).some((s) => mintTarget(file.path, s))
    )
      return true;
  }
  // Other loading forms expose the module rather than a direct mint binding.
  const withoutImports = maskSource(file.text, false).replace(
    /\bimport\s+[^;]*?\s+from\s*["'][^"']+["']\s*;?/g,
    "",
  );
  if (
    importsOf({ ...file, text: withoutImports }).some((s) =>
      mintTarget(file.path, s),
    )
  )
    return true;
  const source = maskSource(parsedSource(file), false);
  const bindings = new Set<string>();
  // Remove binding declarations, leaving every use for the direct-call check.
  const references = source.replace(
    /\bimport\s+([^;]*?)\s+from\s*["'][^"']+["']\s*;?/g,
    (declaration: string, clause: string) => {
      if (
        !importsOf({ ...file, text: declaration }).some((s) =>
          mintTarget(file.path, s),
        )
      )
        return declaration;
      const namespace = /\*\s+as\s+([$\w]+)/.exec(clause);
      if (namespace) bindings.add(namespace[1]!);
      for (const name of clause.matchAll(
        /\bmintIdentity(?:\s+as\s+([$\w]+))?/g,
      ))
        bindings.add(name[1] ?? "mintIdentity");
      return "";
    },
  );
  const code = maskSource(references, true);
  if (file.path === "cloud/src/adapters/workers-oauth/index.ts") {
    const scopes: string[] = [];
    for (const match of code.matchAll(
      /\bfunction\s+([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)\s*\([^)]*\)\s*\{|=>|\)\s*\{|\b(?:class|function)\b|[{}]|[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/gu,
    )) {
      const [token, name] = match;
      if (name === "createOAuthAdapter" && scopes.length) return true;
      if (name) scopes.push(name);
      else if (token === "{") scopes.push("");
      else if (token === "}") scopes.pop();
      else if (
        bindings.has(token) &&
        scopes.filter(Boolean).join("/") !==
          "createOAuthAdapter/verifyProviderToken"
      )
        return true;
      else if (/^(?:=>|\)|class\b|function\b)/.test(token)) {
        if (scopes.includes("verifyProviderToken")) return true;
        if (token.endsWith("{")) scopes.push("nested");
      }
    }
  }
  for (const match of code.matchAll(
    /[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/gu,
  ))
    if (
      bindings.has(match[0]) &&
      (!/^\s*\(/.test(code.slice(match.index + match[0].length)) ||
        /\bnew\s*$/.test(code.slice(0, match.index)))
    )
      return true;
  return false;
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
